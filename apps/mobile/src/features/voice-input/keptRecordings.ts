import { Directory, File, Paths } from "expo-file-system";

/** Enough that a new, retried or canceled recording does not push out the one being recovered. */
export const KEPT_VOICE_RECORDINGS = 5;

const FILE_NAME = /^dictation-(\d+)\.m4a$/;

export interface KeptVoiceRecording {
  readonly uri: string;
  readonly recordedAt: number;
}

function folder(): Directory {
  return new Directory(Paths.cache, "dictation-recordings");
}

/** The dictation recordings still on the device, newest first. */
export function keptVoiceRecordings(): ReadonlyArray<KeptVoiceRecording> {
  try {
    const kept = folder();
    if (!kept.exists) return [];
    return kept
      .list()
      .flatMap((entry) => {
        const recordedAt = entry instanceof File ? FILE_NAME.exec(entry.name)?.[1] : undefined;
        return recordedAt === undefined ? [] : [{ uri: entry.uri, recordedAt: Number(recordedAt) }];
      })
      .sort((left, right) => right.recordedAt - left.recordedAt);
  } catch {
    return [];
  }
}

/** Returns where the recording is now: the kept place, or where it was if it could not be moved. */
export function keepVoiceRecording(uri: string): string {
  let keptUri: string;
  try {
    const kept = folder();
    if (!kept.exists) kept.create({ intermediates: true, idempotent: true });
    const destination = new File(kept, `dictation-${Date.now()}.m4a`);
    // The synchronous move: the recording is transcribed from its new place straight after.
    new File(uri).moveSync(destination);
    keptUri = destination.uri;
  } catch {
    return uri;
  }
  for (const old of keptVoiceRecordings().slice(KEPT_VOICE_RECORDINGS)) {
    try {
      new File(old.uri).delete();
    } catch {
      // It is removed after a later recording.
    }
  }
  return keptUri;
}
