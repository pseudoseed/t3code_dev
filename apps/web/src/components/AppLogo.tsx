import type { ImgHTMLAttributes } from "react";
import appIcon from "../../../../assets/pseudocode/app-icon-180.png";

export function AppLogo(props: Omit<ImgHTMLAttributes<HTMLImageElement>, "src">) {
  return <img alt="PseudoCode" {...props} src={appIcon} />;
}
