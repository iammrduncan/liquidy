import { ApplicationIntegrationType, type ClientApplication } from "discord.js";
import { errorText, log } from "./log.ts";

interface Server {
  id: string;
  name: string;
  leave(): Promise<unknown>;
}

/**
 * Leaves every server except the one the bot watches, so the bot stays private even if someone
 * else manages to add it. Returns the IDs it left.
 */
export async function leaveOtherServers(
  servers: Iterable<Server>,
  keepId: string,
): Promise<string[]> {
  const left: string[] = [];
  for (const server of servers) {
    if (server.id === keepId) continue;
    try {
      await server.leave();
      left.push(server.id);
      log.warn("left a server other than GUILD_ID", { guildId: server.id, name: server.name });
    } catch (e) {
      log.error("could not leave a server other than GUILD_ID", {
        guildId: server.id,
        error: errorText(e),
      });
    }
  }
  return left;
}

/**
 * Warns when the application's Developer Portal settings let others install it. The code cannot
 * change these; the README lists the switches.
 */
export async function warnIfInstallable(application: ClientApplication): Promise<void> {
  try {
    const app = await application.fetch();
    if (app.botPublic)
      log.warn(
        "Public Bot is on: anyone with the invite link can add the bot (it leaves at once). " +
          "Set Installation > Install Link to None, then turn off Bot > Public Bot.",
      );
    if (app.integrationTypesConfig?.[ApplicationIntegrationType.UserInstall])
      log.warn(
        "User Install is on: anyone can add the app to their account. " +
          "Untick it under Installation > Installation Contexts.",
      );
  } catch (e) {
    log.warn("could not read the application's install settings", { error: errorText(e) });
  }
}
