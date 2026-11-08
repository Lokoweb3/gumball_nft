// Reads `cargo test --features idl-build __anchor_private_print_idl -- --show-output` output
// on stdin and prints a canonical JSON of every IDL block (anchor-cli 0.31 cannot run on
// older glibc, so this stands in for `anchor idl build`). Blocks are sorted by label+name
// so moving code between modules (which reorders the test names) does not change the output.
const lines = require('fs').readFileSync(0, 'utf8').split('\n');
const blocks = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^--- IDL begin (\w+) ---$/);
  if (!m) continue;
  const body = [];
  for (i++; !lines[i].startsWith('--- IDL end'); i++) body.push(lines[i]);
  const json = JSON.parse(body.join('\n'));
  blocks.push({ label: m[1], json });
}
const key = (b) => b.label + ':' + (b.json.name || b.json.event || b.json.address || '');
blocks.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
process.stdout.write(JSON.stringify(blocks, null, 2) + '\n');
