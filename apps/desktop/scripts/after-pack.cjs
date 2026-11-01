// electron-builder afterPack hook: sets the Windows exe icon and version info
// with resedit (pure JS), so Windows builds made on Linux need no Wine.
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const { NtExecutable, NtExecutableResource, Data, Resource } = await import('resedit');
  const info = ctx.packager.appInfo;
  const exePath = join(ctx.appOutDir, `${info.productFilename}.exe`);
  const exe = NtExecutable.from(readFileSync(exePath));
  const res = NtExecutableResource.from(exe);
  const iconFile = Data.IconFile.from(readFileSync(join(__dirname, '..', 'resources', 'icon.ico')));
  for (const group of Resource.IconGroupEntry.fromEntries(res.entries)) {
    Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, iconFile.icons.map((i) => i.data));
  }
  const [vi] = Resource.VersionInfo.fromEntries(res.entries);
  const [major, minor, patch] = info.version.split('.').map(Number);
  vi.setFileVersion(major, minor, patch, 0, 1033);
  vi.setProductVersion(major, minor, patch, 0, 1033);
  vi.setStringValues(
    { lang: 1033, codepage: 1200 },
    {
      FileDescription: 'AETHER Browser',
      ProductName: 'AETHER',
      CompanyName: 'AETHER contributors',
      LegalCopyright: 'AETHER contributors, MPL-2.0',
      OriginalFilename: `${info.productFilename}.exe`,
      InternalName: 'aether',
      FileVersion: info.version,
      ProductVersion: info.version,
    },
  );
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`  • exe resources set by resedit  file=${exePath}`);
};
