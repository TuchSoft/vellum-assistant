/**
 * Document revision history: snapshots of a document's title and body as they
 * stood at a revision, taken just before a write replaces that state.
 *
 * Snapshot writes run inside the caller's transaction, next to the document
 * write they precede, so a snapshot exists exactly when its write landed.
 */
import type { AsyncDb } from "../persistence/db-facade.js";
import { requireMainDb } from "../persistence/db-facade.js";

/** Who made the write a snapshot was taken ahead of. */
export type DocumentRevisionAuthor = "user" | "assistant";

/** Snapshots kept per document; older ones are pruned on each insert. */
export const MAX_REVISIONS_PER_DOCUMENT = 100;

/**
 * A user save snapshots the prior state at most this often per document,
 * unless the latest snapshot preceded an assistant edit.
 */
export const USER_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

export interface DocumentRevisionSummary {
  revision: number;
  author: DocumentRevisionAuthor;
  createdAt: number;
  wordCount: number;
  title: string;
}

export interface DocumentRevisionRecord extends DocumentRevisionSummary {
  content: string;
}

/** The document state a snapshot preserves. */
export interface DocumentSnapshotSource {
  surfaceId: string;
  revision: number;
  title: string;
  content: string;
  wordCount: number;
}

interface RevisionRow {
  revision: number;
  author: DocumentRevisionAuthor;
  created_at: number;
  word_count: number;
  title: string;
  content: string;
}

function mapRowToSummary(
  row: Omit<RevisionRow, "content">,
): DocumentRevisionSummary {
  return {
    revision: row.revision,
    author: row.author,
    createdAt: row.created_at,
    wordCount: row.word_count,
    title: row.title,
  };
}

/**
 * Store `state` as the snapshot for its revision and prune the document's
 * history to the newest {@link MAX_REVISIONS_PER_DOCUMENT}. A revision that is
 * already snapshotted keeps its first snapshot.
 */
export async function recordDocumentSnapshot(
  state: DocumentSnapshotSource,
  author: DocumentRevisionAuthor,
  db: AsyncDb = requireMainDb(),
): Promise<void> {
  await db.run(
    /*sql*/ `INSERT INTO document_revisions (surface_id, revision, title, content, word_count, author, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      state.surfaceId,
      state.revision,
      state.title,
      state.content,
      state.wordCount,
      author,
      Date.now(),
    ],
  );
  await db.run(
    /*sql*/ `DELETE FROM document_revisions
     WHERE surface_id = ?
       AND revision NOT IN (
         SELECT revision FROM document_revisions
         WHERE surface_id = ?
         ORDER BY revision DESC
         LIMIT ?
       )`,
    [state.surfaceId, state.surfaceId, MAX_REVISIONS_PER_DOCUMENT],
  );
}

/**
 * Whether a user save should snapshot the state it replaces: when the document
 * has no snapshot yet, when the latest one is older than
 * {@link USER_SNAPSHOT_INTERVAL_MS}, or when the latest one preceded an
 * assistant edit, so the assistant's result survives the user's next edits.
 */
export async function shouldSnapshotBeforeUserSave(
  surfaceId: string,
  db: AsyncDb = requireMainDb(),
): Promise<boolean> {
  const latest = await db.get<{ author: string; created_at: number }>(
    /*sql*/ `SELECT author, created_at FROM document_revisions
     WHERE surface_id = ?
     ORDER BY revision DESC
     LIMIT 1`,
    [surfaceId],
  );
  if (!latest) {
    return true;
  }
  return (
    latest.author === "assistant" ||
    Date.now() - latest.created_at >= USER_SNAPSHOT_INTERVAL_MS
  );
}

/** A document's snapshots, newest first, without their bodies. */
export async function listDocumentRevisions(
  surfaceId: string,
): Promise<DocumentRevisionSummary[]> {
  const db = requireMainDb();
  const rows = await db.all<Omit<RevisionRow, "content">>(
    /*sql*/ `SELECT revision, author, created_at, word_count, title
     FROM document_revisions
     WHERE surface_id = ?
     ORDER BY revision DESC`,
    [surfaceId],
  );
  return rows.map(mapRowToSummary);
}

/** One snapshot with its body, or `null` when it does not exist. */
export async function getDocumentRevision(
  surfaceId: string,
  revision: number,
  db: AsyncDb = requireMainDb(),
): Promise<DocumentRevisionRecord | null> {
  const row = await db.get<RevisionRow>(
    /*sql*/ `SELECT revision, author, created_at, word_count, title, content
     FROM document_revisions
     WHERE surface_id = ? AND revision = ?`,
    [surfaceId, revision],
  );
  return row ? { ...mapRowToSummary(row), content: row.content } : null;
}
