const { withAppBuildGradle, withProjectBuildGradle } = require('expo/config-plugins');

/**
 * Moves each native module's C++ build directory to a short path, on Windows.
 *
 * Without this the Android build cannot complete on a machine where Windows
 * long paths are disabled. CMake writes an object file to
 *
 *   <module>/.cxx/<config>/<hash>/<abi>/CMakeFiles/<target>.dir/<source path>
 *
 * and when a source sits outside its own CMakeLists directory — which is true
 * of expo-modules-core's `common/cpp` — it appends the source's *absolute*
 * path with the colon mangled, so the full path contains this repository's
 * location twice. Under pnpm, which nests each package as
 * `node_modules/.pnpm/<name>@<version>/node_modules/<name>`, that reaches
 * roughly 370 characters. CMake refuses anything over 250 and ninja then spins
 * until it gives up with "manifest 'build.ninja' still dirty after 100 tries".
 *
 * Raising CMAKE_OBJECT_PATH_MAX is not enough: CMake then plans the long paths
 * and ninja cannot create them, because long path support is off at the OS
 * level and turning it on needs administrator rights. Shortening the other end
 * is what works — only the staging directory is ours to move, and moving it
 * takes about 120 characters off the total.
 *
 * Nothing here applies off Windows, where none of this is a limit.
 */

const MARKER = 'psx-trader: short native build path';

/** Short enough to leave room for the mangled source path CMake appends. */
const DEFAULT_STAGING_ROOT = 'C:/b';

function gradleBlock(stagingRoot) {
  return `
// ${MARKER}
// Added by plugins/withShortNativeBuildPath.js — see that file for why.
def psxShortenCxxPath = { project ->
    if (project.extensions.findByName('android') == null) {
        return
    }
    try {
        project.android.externalNativeBuild.cmake.buildStagingDirectory =
            new File('${stagingRoot}/' + project.name)
    } catch (Exception ignored) {
        // Already configured, or the module has no CMake build. Either way
        // there is nothing to shorten, and a module without long C++ source
        // paths builds fine where it is.
    }
}
subprojects { sub ->
    if (sub.state.executed) {
        psxShortenCxxPath(sub)
    } else {
        sub.afterEvaluate { psxShortenCxxPath(sub) }
    }
}
`;
}

/**
 * The app module needs its own edit. The subprojects hook above reaches it too
 * late — AGP finalizes buildStagingDirectory while app/build.gradle is being
 * evaluated, so an afterEvaluate assignment is rejected with "It is too late
 * to set buildStagingDirectory" and the module quietly keeps the long path.
 * With the new architecture on, the app module compiles generated C++ for
 * every autolinked view, and those paths are the longest in the build:
 * react_codegen_safeareacontext's shadow node overran 260 characters.
 */
function withAppStagingDirectory(config, stagingRoot) {
  return withAppBuildGradle(config, (gradleConfig) => {
    if (gradleConfig.modResults.contents.includes(MARKER)) {
      return gradleConfig;
    }

    const anchor = '\nandroid {\n';
    const index = gradleConfig.modResults.contents.indexOf(anchor);
    if (index === -1) {
      throw new Error('withShortNativeBuildPath could not find the android block in app/build.gradle.');
    }

    const insertion = [
      `    // ${MARKER}`,
      '    externalNativeBuild {',
      '        cmake {',
      `            buildStagingDirectory = new File('${stagingRoot}/app')`,
      '        }',
      '    }',
      '',
    ].join('\n');

    gradleConfig.modResults.contents =
      gradleConfig.modResults.contents.slice(0, index + anchor.length) +
      insertion +
      gradleConfig.modResults.contents.slice(index + anchor.length);

    return gradleConfig;
  });
}

module.exports = function withShortNativeBuildPath(config, props) {
  if (process.platform !== 'win32') {
    return config;
  }

  const stagingRoot =
    (props && props.stagingRoot) || process.env.PSX_CXX_STAGING || DEFAULT_STAGING_ROOT;

  const withApp = withAppStagingDirectory(config, stagingRoot);

  return withProjectBuildGradle(withApp, (gradleConfig) => {
    if (gradleConfig.modResults.language !== 'groovy') {
      throw new Error(
        `withShortNativeBuildPath expected a Groovy build.gradle, got ${gradleConfig.modResults.language}.`,
      );
    }

    // Prebuild can run against an existing file, so do not append twice.
    if (gradleConfig.modResults.contents.includes(MARKER)) {
      return gradleConfig;
    }

    gradleConfig.modResults.contents += gradleBlock(stagingRoot);
    return gradleConfig;
  });
};
