import type { ModeSession, ModeSessionMode } from "../api/mode-session.js";
import type {
  ConversationModeSessionCoordinator,
  ModeSessionSourceHandle,
  ModeSessionTerminalDisposition,
} from "../daemon/conversation-mode-session.js";
import type { LiveVoiceSightSource } from "./protocol.js";

type ModeSessionCoordinator = Pick<
  ConversationModeSessionCoordinator,
  | "activateSource"
  | "claimTurn"
  | "recordActivity"
  | "releaseTurn"
  | "retireSource"
  | "trackPersistedRow"
>;

interface CameraRun {
  readonly epoch: number;
  readonly source: LiveVoiceSightSource;
  readonly handle: ModeSessionSourceHandle;
  readonly syntheticTurnId: string;
  pendingFrames: number;
  retired: boolean;
}

export interface CameraFrameToken {
  readonly owner: ModeSessionSourceHandle;
  readonly epoch: number;
  readonly activation: number;
}

function modeFor(source: LiveVoiceSightSource): ModeSessionMode {
  return source === "ambient" ? "ambient" : "live_vision";
}

/** Maps one voice session's negotiated camera epochs onto durable sessions. */
export class CameraModeSessionProducer {
  readonly #coordinator: ModeSessionCoordinator;
  readonly #sourceId: string;
  readonly #runs = new Map<number, CameraRun>();
  readonly #pendingFrameTokens = new Set<CameraFrameToken>();
  #activeRun?: CameraRun;
  #highestEpoch = 0;

  constructor(coordinator: ModeSessionCoordinator, voiceSessionId: string) {
    this.#coordinator = coordinator;
    this.#sourceId = `live-voice-camera:${voiceSessionId}`;
  }

  async start(
    epoch: number,
    source: LiveVoiceSightSource = "live",
    at = Date.now(),
  ): Promise<ModeSessionSourceHandle | undefined> {
    const known = this.#runs.get(epoch);
    if (known) {
      return !known.retired && known.source === source
        ? known.handle
        : undefined;
    }
    if (epoch <= this.#highestEpoch) {
      return undefined;
    }

    if (this.#activeRun) {
      await this.#retire(this.#activeRun, {
        status: "interrupted",
        endReason: "camera_source_replaced",
      });
    }

    const handle = await this.#coordinator.activateSource({
      sourceId: this.#sourceId,
      generation: epoch,
      mode: modeFor(source),
      sourceStartedAt: at,
      lifetime: "source",
    });
    if (!handle) {
      return undefined;
    }

    const syntheticTurnId = `${this.#sourceId}:${epoch}:${handle.activation}`;
    let owner: ModeSession | undefined;
    try {
      owner = await this.#coordinator.claimTurn(syntheticTurnId, handle, at);
    } catch (err) {
      const rollbackError = await this.#rollbackStart(handle, syntheticTurnId);
      if (rollbackError) {
        throw new AggregateError(
          [err, rollbackError],
          "Camera session claim and rollback both failed",
        );
      }
      throw err;
    }
    if (!owner || owner.id !== handle.id) {
      const rollbackError = await this.#rollbackStart(handle, syntheticTurnId);
      if (rollbackError) {
        throw rollbackError;
      }
      return undefined;
    }

    const run: CameraRun = {
      epoch,
      source,
      handle,
      syntheticTurnId,
      pendingFrames: 0,
      retired: false,
    };
    this.#runs.set(epoch, run);
    this.#highestEpoch = epoch;
    this.#activeRun = run;
    return handle;
  }

  async #rollbackStart(
    handle: ModeSessionSourceHandle,
    syntheticTurnId: string,
  ): Promise<unknown> {
    let rollbackError: unknown;
    try {
      await this.#coordinator.retireSource(handle, {
        status: "interrupted",
        endReason: "camera_start_refused",
      });
    } catch (err) {
      rollbackError = err;
    }
    try {
      await this.#coordinator.releaseTurn(syntheticTurnId);
    } catch (err) {
      rollbackError ??= err;
    }
    return rollbackError;
  }

  captureTurn(): ModeSessionSourceHandle | undefined {
    return this.#activeRun?.handle;
  }

  async holdDelivery(
    turnId: string,
    at = Date.now(),
  ): Promise<ModeSessionSourceHandle | undefined> {
    const handle = this.captureTurn();
    if (!handle) {
      return undefined;
    }
    const owner = await this.#coordinator.claimTurn(turnId, handle, at);
    return owner?.id === handle.id ? handle : undefined;
  }

  async releaseDelivery(turnId: string): Promise<void> {
    await this.#coordinator.releaseTurn(turnId);
  }

  beginFrame(
    epoch: number,
    source: LiveVoiceSightSource | undefined,
  ): CameraFrameToken | undefined {
    const run = this.#activeRun;
    if (
      !run ||
      run.retired ||
      run.epoch !== epoch ||
      (source !== undefined && source !== run.source)
    ) {
      return undefined;
    }
    run.pendingFrames += 1;
    const token = {
      owner: run.handle,
      epoch: run.epoch,
      activation: run.handle.activation,
    };
    this.#pendingFrameTokens.add(token);
    return token;
  }

  async finishFrame(
    token: CameraFrameToken | undefined,
    persisted?: { messageId: string; at: number },
  ): Promise<void> {
    if (!token || !this.#pendingFrameTokens.delete(token)) {
      return;
    }
    const run = this.#runs.get(token.epoch);
    if (!run || run.handle.activation !== token.activation) {
      return;
    }
    try {
      if (
        persisted &&
        (await this.#coordinator.recordActivity(
          run.syntheticTurnId,
          persisted.at,
        ))
      ) {
        await this.#coordinator.trackPersistedRow(
          run.syntheticTurnId,
          persisted.messageId,
          persisted.at,
        );
        await this.#coordinator.recordActivity(
          run.syntheticTurnId,
          persisted.at,
        );
      }
    } finally {
      run.pendingFrames = Math.max(0, run.pendingFrames - 1);
      await this.#releaseIfSettled(run);
    }
  }

  async end(
    epoch: number,
    disposition: ModeSessionTerminalDisposition = {
      status: "completed",
      endReason: "camera_stopped",
    },
  ): Promise<boolean> {
    const run = this.#runs.get(epoch);
    if (!run || run.retired) {
      return false;
    }
    return await this.#retire(run, disposition);
  }

  async close(disposition: ModeSessionTerminalDisposition): Promise<boolean> {
    const run = this.#activeRun;
    return run ? await this.#retire(run, disposition) : false;
  }

  async #retire(
    run: CameraRun,
    disposition: ModeSessionTerminalDisposition,
  ): Promise<boolean> {
    if (run.retired) {
      return false;
    }
    let retired = false;
    let retirementError: unknown;
    try {
      retired = await this.#coordinator.retireSource(run.handle, disposition);
    } catch (err) {
      retirementError = err;
    }
    run.retired = true;
    if (this.#activeRun === run) {
      this.#activeRun = undefined;
    }
    let releaseError: unknown;
    try {
      await this.#releaseIfSettled(run);
    } catch (err) {
      releaseError = err;
    }
    if (retirementError && releaseError) {
      throw new AggregateError(
        [retirementError, releaseError],
        "Camera session retirement and turn release both failed",
      );
    }
    if (retirementError) {
      throw retirementError;
    }
    if (releaseError) {
      throw releaseError;
    }
    return retired;
  }

  async #releaseIfSettled(run: CameraRun): Promise<void> {
    if (run.retired && run.pendingFrames === 0) {
      await this.#coordinator.releaseTurn(run.syntheticTurnId);
    }
  }
}
