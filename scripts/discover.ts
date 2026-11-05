// One-time setup helper: prints Skylight frames/lists, upcoming calendar events, and recent iMessage chats.
// Usage: npm run discover            (both)
//        npm run discover skylight   (Skylight only)
//        npm run discover calendar   (Google Calendar only)
//        npm run discover chats      (chat.db only)
import { calendarFromEnv } from '../src/google/calendar.ts';
import { openDb, recentChats } from '../src/imessage/reader.ts';
import { clientFromEnv } from '../src/skylight/client.ts';

const which = process.argv[2];
const want = (section: string) => !which || which === section;

if (want('skylight')) {
  console.log('== Skylight ==');
  try {
    const sky = clientFromEnv();
    const frames = await sky.frames();
    for (const f of frames) console.log(`frame ${f.id}  ${f.name}`);
    if (frames.length === 1 || process.env.SKYLIGHT_FRAME_ID) {
      for (const l of await sky.lists()) {
        const items = await sky.items(l.id);
        console.log(`  list ${l.id}  ${l.label} (${l.kind}), ${items.filter((i) => i.status === 'pending').length} pending`);
      }
    } else {
      console.log('Multiple frames; set SKYLIGHT_FRAME_ID and re-run to see lists.');
    }
  } catch (err) {
    console.log(`Skylight failed: ${(err as Error).message}`);
  }
}

if (want('calendar')) {
  console.log('\n== Google Calendar (next 14 days) ==');
  try {
    const cal = calendarFromEnv();
    console.log(`service account: ${cal.serviceAccountEmail}`);
    const ymd = (d: Date) => d.toLocaleDateString('en-CA');
    const events = await cal.events(ymd(new Date()), ymd(new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)));
    for (const e of events) console.log(`  ${e.start}  ${e.title}`);
    if (!events.length) console.log('  (no events, but the calendar is reachable)');
  } catch (err) {
    console.log(`Calendar failed (is it shared with the service account?): ${(err as Error).message}`);
  }
}

if (want('chats')) {
  console.log('\n== Recent iMessage chats ==');
  try {
    const db = openDb();
    for (const c of recentChats(db)) {
      console.log(`${c.lastMessageAt.toLocaleString()}  ${c.guid}`);
      console.log(`    ${c.name ?? '(no name)'}: ${c.participants.join(', ')}`);
    }
  } catch (err) {
    console.log(`chat.db failed (grant Full Disk Access to node/Terminal): ${(err as Error).message}`);
  }
}
