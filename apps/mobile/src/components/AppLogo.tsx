import { Image } from "expo-image";

/** Shared app icon for headers and work-log entries. */
export function AppLogo(props: { readonly height: number }) {
  return (
    <Image
      source={require("../../../../assets/pseudocode/app-icon-180.png")}
      accessibilityLabel="PseudoCode"
      accessibilityIgnoresInvertColors
      style={{ width: props.height, height: props.height }}
    />
  );
}
