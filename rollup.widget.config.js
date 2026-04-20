const typescript = require("@rollup/plugin-typescript");
const path = require("path");

module.exports = {
  input: "widget-src/widget.ts",
  output: {
    file:    "widget-dist/widget.js",
    format:  "amd",           // Ming.le inline widget'lar AMD formatı bekler
    name:    "widget",
    amd: {
      id: "widget"
    },
    globals: {
      lime: "lime",
    },
  },
  external: ["lime"],          // lime runtime'da Ming.le tarafından sağlanır
  plugins: [
    typescript({
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
    }),
  ],
};
