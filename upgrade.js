// `obsidian-pkm upgrade dismiss <step> [<target>]` and `obsidian-pkm upgrade reset`.

/**
 * @param {string[]} args the arguments after `upgrade`
 * @param {{ env?: Record<string, string|undefined>, home?: string, now?: Date,
 *   stdout?: { write(text: string): unknown }, stderr?: { write(text: string): unknown } }} [options]
 * @returns {Promise<number>} 0 done; 1 the file could not be written; 2 usage error
 */
export async function runUpgrade(args, options) {
  throw new Error("not implemented");
}
