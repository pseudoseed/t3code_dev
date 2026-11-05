import { Observe } from "expo-observe";

// PseudoCode sends no crash reports. Importing expo-observe installs its global error handler,
// and Observe keeps its last configuration across launches, so sending is switched off here.
Observe.configure({ dispatchingEnabled: false });
