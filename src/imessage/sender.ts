import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Text and chat id travel as argv, so no AppleScript string escaping is needed.
const SCRIPT = `
on run argv
  set msg to item 1 of argv
  set chatId to item 2 of argv
  tell application "Messages" to send msg to chat id chatId
end run`;

export async function sendToChat(chatGuid: string, text: string) {
  try {
    await run('osascript', ['-e', SCRIPT, text, chatGuid], { timeout: 30_000 });
  } catch (err) {
    // -1728: this macOS user's Messages has no such chat, i.e. not running as the bot user.
    if (String((err as { stderr?: string }).stderr).includes('(-1728)')) {
      throw new Error(`Chat ${chatGuid} is not in ${process.env.USER}'s Messages. Run as the bot user (homebot).`);
    }
    throw err;
  }
}
