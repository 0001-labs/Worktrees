// Ad-hoc re-sign so Apple Silicon + quarantine does not report the app as
// "damaged". A Developer ID Application cert is required to notarize.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  const entitlements = path.join(
    context.packager.projectDir,
    "build",
    "entitlements.mac.plist"
  );
  execFileSync(
    "codesign",
    [
      "--sign",
      "-",
      "--force",
      "--deep",
      "--timestamp=none",
      "--options",
      "runtime",
      "--entitlements",
      entitlements,
      appPath,
    ],
    { stdio: "inherit" }
  );
};
