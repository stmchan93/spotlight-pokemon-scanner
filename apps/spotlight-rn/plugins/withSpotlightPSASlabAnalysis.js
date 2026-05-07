/* global __dirname */

const { withXcodeProject } = require('@expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_FILES = [
  'SpotlightPSASlabAnalysisModule.m',
  'SpotlightPSASlabAnalysisModule.swift',
];

const BRIDGING_HEADER_IMPORT = '#import <React/RCTBridgeModule.h>';

/**
 * Copies SpotlightPSASlabAnalysisModule.{swift,m} into the generated iOS project
 * and registers both files in the Xcode target's Sources build phase.
 *
 * This plugin is needed because EAS Build always runs expo prebuild for this
 * project (the managed-workflow fingerprint check triggers a full regeneration),
 * which wipes ios/ before rebuilding it from config plugins. Without this plugin
 * the native Vision/barcode module is absent from every EAS build.
 */
const withSpotlightPSASlabAnalysis = (config) =>
  withXcodeProject(config, (mod) => {
    const proj = mod.modResults;
    const projectName = mod.modRequest.projectName;
    const iosRoot = mod.modRequest.platformProjectRoot;
    const targetDir = path.join(iosRoot, projectName);
    const srcDir = path.join(__dirname, 'SpotlightPSASlabAnalysis');
    const targetUuid = proj.getFirstTarget().uuid;

    for (const file of MODULE_FILES) {
      fs.copyFileSync(path.join(srcDir, file), path.join(targetDir, file));

      // Skip if this file reference is already in the pbxproj (idempotent).
      const refs = proj.pbxFileReferenceSection();
      const alreadyAdded = Object.values(refs).some(
        (ref) =>
          ref &&
          typeof ref === 'object' &&
          (ref.path === file || ref.path === `"${file}"`),
      );
      if (alreadyAdded) continue;

      proj.addSourceFile(
        path.join(projectName, file),
        { target: targetUuid },
        projectName,
      );
    }

    // Ensure the bridging header exposes RCTBridgeModule to Swift so that
    // RCT_EXTERN_MODULE compiles correctly.
    const bridgingHeaderPath = path.join(
      targetDir,
      `${projectName}-Bridging-Header.h`,
    );
    if (fs.existsSync(bridgingHeaderPath)) {
      const content = fs.readFileSync(bridgingHeaderPath, 'utf8');
      if (!content.includes(BRIDGING_HEADER_IMPORT)) {
        fs.writeFileSync(
          bridgingHeaderPath,
          content.trimEnd() + `\n${BRIDGING_HEADER_IMPORT}\n`,
        );
      }
    }

    return mod;
  });

module.exports = withSpotlightPSASlabAnalysis;
