import esbuild from "esbuild";
import process from "node:process";

const isProduction = process.argv[2] === "production";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2018",
  sourcemap: isProduction ? "inline" : "external",
  minify: isProduction,
  treeShaking: true,
  outfile: "main.js",
  logLevel: "info"
});
