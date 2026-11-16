// Child process for the cross-process write test: appends N unique lines to one note via mutateFile.
import { mutateFile } from "../../vault-fs.js";

const [, , file, tag, count] = process.argv;
for (let i = 0; i < Number(count); i++) {
  await mutateFile(file, (content) => content + `${tag}-${i}\n`);
}
