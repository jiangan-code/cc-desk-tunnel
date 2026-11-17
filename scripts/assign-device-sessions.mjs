import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run only while the service is stopped. Keep native-root families together: forks share native history.
export function assignLegacySessions(directory, deviceId) {
  const database = new DatabaseSync(join(directory, 'sessions.sqlite'));
  try {
    database.exec('BEGIN IMMEDIATE');
    if (!database.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId))
      throw new Error('目标设备尚未注册；先连接新版客户端完成设备注册。');
    const rows = database
      .prepare(
        'SELECT s.id, s.metadata, d.device_id FROM sessions s JOIN session_devices d ON d.session_id = s.id',
      )
      .all();
    const families = new Map();
    for (const row of rows) {
      const metadata = JSON.parse(String(row.metadata));
      const owner = row.device_id === 'legacy' ? deviceId : String(row.device_id);
      const root = metadata.nativeRoot ?? row.id;
      if (families.has(root) && families.get(root) !== owner)
        throw new Error('会话分叉共享原生目录，不能分配到不同设备。');
      families.set(root, owner);
    }
    const result = database
      .prepare("UPDATE session_devices SET device_id = ? WHERE device_id = 'legacy'")
      .run(deviceId);
    database.exec('COMMIT');
    return Number(result.changes);
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      'device-id': { type: 'string' },
      offline: { type: 'boolean' },
    },
  });
  if (!values.offline || !values['data-dir'] || !/^[0-9a-f-]{36}$/i.test(values['device-id'] ?? ''))
    throw new Error(
      '先停止服务并备份数据，再执行：node scripts/assign-device-sessions.mjs --offline --data-dir <状态目录> --device-id <ccdt device 输出的 ID>',
    );
  console.log(
    `已分配 ${assignLegacySessions(resolve(values['data-dir']), values['device-id'])} 个旧会话。`,
  );
}
