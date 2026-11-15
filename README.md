# Rank spoofer — Pengu Loader plugin for the League of Legends client

Show any rank you want, on your own client. Pick a rank for yourself, your alts and your friends, and the League client shows it on profiles, hovercards, leaderboards and end-of-game screens. You can also copy another player's profile with Copycat or share your fake rank with friends who use the plugin.

> **Client-side only.** Everything happens on your own screen. Your real rank, your LP and your games on Riot's servers are never touched, and other players keep seeing your real rank on your profile. See [What other players see](#what-other-players-see).

> **DISCLAIMER !** Some features such as [Sharing](#sharing-with-friends) are using an exploit in Riot API (See [How it works](#how-it-works)). This looks safe so far but might lead to a ban in the future. USE AT YOUR OWN RISKS !


---

## Features

### Virtual ranks
- A rank for any account: **Iron to Challenger**, division, LP, wins / losses and last season's banner.
- Shown **everywhere** on your client:
  - profiles, ranked crests and banners;
  - hovercards and tooltips;
  - custom game lobbies;
  - the "highest rank" crest. If another queue (TFT, Flex...) is higher than your virtual Solo/Duo, that queue is shown instead, like the real client does.
- **Master / Grandmaster / Challenger** follow the real LP cutoffs of your server. They are read from the live top 300, with a manual fallback.
- Negative LP supported.

### Live LP after your games
- After each ranked Solo/Duo game, your virtual LP moves by the **real LP you won or lost**, with promotions and demotions.
- **End-of-game screen**:
  - the header ("Victory", "Promoted to Diamond I", "Demoted to...") follows your **virtual** rank;
  - the result under the emblem ("+19 LP", "Promoted", "Demoted") does too;
  - so do the emblem, the total LP and the **W / L** counter.
- If your *real* rank is promoted or demoted but your virtual one isn't, the screen shows a normal "Victory" / "Defeat" with your LP change.
- **Promotion ceremony**: the full-screen video plays when your **virtual tier** goes up, for example Gold to Platinum. The real ceremony is hidden while "Spoof End of Ranked" is on.

### Leaderboards
- Friends leaderboard and **Master / GM / Challenger** ladders. Virtual players are placed at the right position, and the top 300 keeps its size.

### Name spoofer
- Replace any Riot ID (name and tag) with another one: profiles, chat, friends list, leaderboards, lobbies...

### Copycat
Type a player's `Name#TAG` and copy their profile onto yours:
- icon and level;
- profile background, banner and crest;
- Clash banner and trophy;
- title and challenge tokens;
- mastery score and top champions, and Eternals;
- ranks of every queue (Solo/Duo, Flex, TFT...);
- Riot ID.

In leaderboards **you take their place**, and their own row disappears. Click "Stop" to get your own profile back.

### Sharing with friends
- Friends who **also run the plugin** automatically see your virtual rank, spoofed name and alt accounts.
- **Override**: a button on each friend's card. It keeps your own values instead of what that friend shares.

---

## What other players see

| Who | Where | What they see |
|---|---|---|
| You | Everywhere in your client | Virtual ranks, spoofed names, copied profile |
| Friends **with** the plugin | Everywhere in their client | Your virtual rank, spoofed name and alts |
| Friends **without** the plugin | Hovercard in their friends list | Your virtual rank (sent through your chat presence) |
| Friends **without** the plugin | Your profile page | Your **real** rank (it comes from Riot's servers) |
| Everyone else | Lobbies, champ select, loading screen, profiles | Your **real** rank |

---

## Installation

1. Install [Pengu Loader](https://pengu.lol) and activate it.
2. Download `RankSpoofer.js` from releases.
3. Put `RankSpoofer.js` in Pengu Loader's `plugins` folder.
4. Restart the League client.

The plugin works with the client in English and French. It was last tested on client patch **16.22**.

---

## Usage

Open the **command bar** with `Ctrl + K` and pick:

- **Configure Virtual Ranks and Profiles**: opens the settings menu.
- **Test promotion ceremony (Virtual Ranks)**: plays the promotion video for your current virtual tier, without changing anything.

### Settings menu

| Tab | What's inside |
|---|---|
| **Accounts** | Your connected account, your alts and your friends: rank, LP, W/L, last season banner, spoofed name, Override button. Add accounts with "+ My account", "+ Visited profile" (open their profile first) or "+ Blank". |
| **Copycat** | Copy a player's profile by `Name#TAG`, or stop copying. |
| **Display** | Turn each part on or off: profiles and banners, hovercards, end of ranked, leaderboards, name spoofer. |
| **Sharing** | Send your rank to friends, also share your alts, receive your friends' ranks. |
| **Advanced** | Master+ cutoffs (automatic or manual) and a "Reload UI" button. |

Click **Save Changes** to apply. Some screens need a **Reload UI**, for example after Copycat.

### Console helpers

Open the client DevTools (`Ctrl + Shift + I`) and type any of these in the console:

```js
VirtualRanksCopycat('Name#TAG')       // copy a profile
VirtualRanksCopycat(null)             // stop copying
VirtualRanksTestPromotion('DIAMOND')  // play the promotion ceremony for a tier
VirtualRanksDebug()                   // plugin status (hooks, cutoffs...)
await VirtualRanksShareDebug()        // what your friends are sharing with you
```

---

## How it works

- **Client data**: the League client gets its data from a local API (the LCU) through `XMLHttpRequest`, and gets live updates through a WebSocket. The plugin rewrites those responses before the client reads them. The client then displays the virtual data with its own UI, so layout and animations stay intact.
- **Text**: a few texts that are not driven by data are replaced in the page, for example "Victory" and "Promoted" on the end-of-game screen.
- **Sharing**: your rank and spoofed name are added to your chat presence (`/lol-chat/v1/me`). Riot's chat servers relay it to your friends, and their plugin reads it.
- **Storage**: all settings stay in Pengu Loader's `DataStore`, on your PC.

---

## Limitations

- Other players' profiles, lobbies and loading screens show your real rank. That data comes from Riot's servers and can't be changed from your client.
- After an update, the League client may move or rename things, and some parts can stop working until the plugin is updated.
- Copycat: the Clash trophy and a few other profile items are learned the first time the client asks for them. If one is missing, open your profile, click **Reload UI** and open it again.

---

## Disclaimer

This project is not affiliated with or endorsed by Riot Games. Modifying the League client may go against Riot's Terms of Service, so use it at your own risk. The plugin does not touch the game, your account or Riot's servers, and it gives no gameplay advantage.
