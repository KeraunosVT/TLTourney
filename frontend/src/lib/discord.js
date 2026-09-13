// The tournament Discord.
//
// One copy, because of the warning below. This used to be declared separately
// in Login.jsx and Home.jsx, which is exactly the arrangement where one of them
// gets refreshed and the other quietly goes on handing out a dead link.
//
// ⚠️  This must be a NEVER-EXPIRING invite. A default Discord invite dies after
// 7 days, and an expired one does not look broken: people land on "Invite
// Invalid", assume the tournament is closed, and leave.
export const DISCORD_INVITE = 'https://discord.gg/p7WPgFku9K';
