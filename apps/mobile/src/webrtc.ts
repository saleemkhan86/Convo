/**
 * WebRTC bridge for the mobile app (Phase 5F).
 *
 * `react-native-webrtc` carries native code, so it only works in a development
 * build (`npx expo run:android|ios`, or `eas build --profile development`) —
 * Expo Go has no WebRTC and the library throws the moment it is evaluated. It
 * is therefore required lazily and its failure is a supported app state: every
 * call surface asks `webrtcSupported()` before it dials.
 */
import type * as WebRtc from "react-native-webrtc";

declare const require: (id: string) => typeof WebRtc;

let loaded: typeof WebRtc | null | undefined;

export const WEBRTC_UNSUPPORTED =
  "Voice and video calls need a development build — this build has no WebRTC module.";

export function webrtc(): typeof WebRtc | null {
  if (loaded === undefined) {
    try {
      loaded = require("react-native-webrtc");
    } catch {
      loaded = null;
    }
  }
  return loaded;
}

export function webrtcSupported(): boolean {
  return webrtc() !== null;
}

export type PeerConnection = InstanceType<typeof WebRtc.RTCPeerConnection>;
export type MediaStream = WebRtc.MediaStream;
export type MediaStreamTrack = WebRtc.MediaStreamTrack;
