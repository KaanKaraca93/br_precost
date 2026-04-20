const typescript = require("@rollup/plugin-typescript");

const tsPlugin = () => typescript({
  tsconfig: false,
  compilerOptions: {
    target:            "ES5",
    module:            "ESNext",
    moduleResolution:  "node",
    strict:            false,
    skipLibCheck:      true,
    allowSyntheticDefaultImports: true,
  },
  include: ["widget-src/**/*.ts"],
});

const buildConfig = (inputFile, outputFile, amdId) => ({
  input: `widget-src/${inputFile}`,
  output: {
    file:    `widget-dist/${outputFile}`,
    format:  "amd",
    name:    amdId,
    amd:     { id: amdId },
    globals: { lime: "lime" },
  },
  external: ["lime"],
  plugins:  [tsPlugin()],
});

module.exports = [
  buildConfig("widget.ts",  "widget.js",  "widget"),
  buildConfig("widget2.ts", "widget2.js", "widget2"),
];
