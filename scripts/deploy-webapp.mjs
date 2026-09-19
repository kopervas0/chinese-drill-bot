// Выгружает webapp/ в бакет Yandex Object Storage через AWS CLI.
// Content-Type задаётся явно: на Windows AWS CLI берёт типы из реестра,
// и .js может получить неверный тип, из-за чего браузер не запустит модуль.
// Использование: npm run webapp:deploy -- <имя-бакета> [--dry]
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const root = join(import.meta.dirname, "..");
const dir = join(root, "webapp");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const bucket = args.find((a) => !a.startsWith("--")) ?? process.env.WEBAPP_BUCKET;

if (!bucket) {
  console.error("Использование: npm run webapp:deploy -- <имя-бакета> [--dry]");
  process.exit(1);
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function walk(d) {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
  );
}

execFileSync(process.execPath, [join(root, "scripts", "build-webapp.mjs")], { stdio: "inherit" });

const files = walk(dir);
for (const file of files) {
  const type = types[extname(file)];
  if (!type) {
    console.error(`Неизвестный тип файла: ${file}`);
    process.exit(1);
  }
  const key = relative(dir, file).split(sep).join("/");
  const awsArgs = [
    "s3", "cp", file, `s3://${bucket}/${key}`,
    "--endpoint-url", "https://storage.yandexcloud.net",
    "--region", "ru-central1",
    "--content-type", type,
    "--cache-control", "no-cache",
  ];
  if (dry) {
    console.log("aws", awsArgs.join(" "));
    continue;
  }
  const res = spawnSync("aws", awsArgs, { stdio: "inherit" });
  if (res.error?.code === "ENOENT") {
    console.error("AWS CLI не найден. Установите его: https://aws.amazon.com/cli/");
    process.exit(1);
  }
  if (res.status !== 0) process.exit(res.status ?? 1);
}

console.log(dry ? "\nПробный запуск, ничего не загружено." : `\nГотово: https://${bucket}.website.yandexcloud.net/`);
