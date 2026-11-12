// 构建后把控制台的静态页面（HTML/CSS/JS）复制到 dist，供 node dist/cli.js run 使用
import { cpSync } from "node:fs";
cpSync("src/console/static", "dist/console/static", { recursive: true });
console.log("已复制控制台静态文件到 dist/console/static");
