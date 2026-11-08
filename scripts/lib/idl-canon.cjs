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
// The raw idl-build output names types by module path ("gumball_nft::XntDebt", or
// "gumball_nft::state::xnt::XntDebt" once code moves into modules); anchor-cli strips the
// prefix in the final IDL, so do the same or a pure module move would show as a diff.
const strip = (v) =>
  typeof v === 'string' ? v.replace(/^(\w+::)+(\w+)$/, '$2')
  : Array.isArray(v) ? v.map(strip)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)]))
  : v;
for (const b of blocks) b.json = strip(b.json);
// accounts/types arrive in module-path order (also path-dependent), so sort them by name.
for (const b of blocks) for (const k of ['accounts', 'types']) {
  if (Array.isArray(b.json[k])) b.json[k].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}
const key = (b) => b.label + ':' + (b.json.name || b.json.event || b.json.address || '');
blocks.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
process.stdout.write(JSON.stringify(blocks, null, 2) + '\n');
