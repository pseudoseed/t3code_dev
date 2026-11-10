import { useEffect, useState } from "react";

import { getLocalVoiceTranscriber as getSystemVoiceTranscriber } from "../../native/voiceTranscription";

let known: boolean | null = null;

/**
 * Whether Apple's recognizer can run here: false before iOS 26, on a simulator, and for a device
 * language it does not take. Null until the first answer of this app run.
 */
export function useAppleDictationAvailable(): boolean | null {
  const [available, setAvailable] = useState(known);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- availability is asked of the system recognizer, which answers asynchronously
  useEffect(() => {
    let mounted = true;
    void getSystemVoiceTranscriber()
      .then(
        (system) => system !== null,
        () => false,
      )
      .then((answer) => {
        known = answer;
        if (mounted) setAvailable(answer);
      });
    return () => {
      mounted = false;
    };
  }, []);
  return available;
}
