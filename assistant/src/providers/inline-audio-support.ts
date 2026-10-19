import { modelSupportsAudioInput } from "./model-catalog.js";

/**
 * Whether eligible audio attachments should be sent inline as `input_audio`
 * for this model id. Capability comes from the model catalog; with gateway
 * aliases the alias must declare audio support in its catalog entry.
 */
export function requestSupportsInlineAudio(modelId: string): boolean {
  return modelSupportsAudioInput(modelId);
}
