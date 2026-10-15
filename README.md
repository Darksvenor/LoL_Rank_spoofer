# LoL_Rank_spoofer
A tool to change your rank thoughout the whole LoL client (and game)

## Disclaimer 
This mod is only visible to you and only visual, your friends and other players wont see the changes this mod makes.

This mod is provided "as is" and i can't be held responsible for any damage it may cause.

The vast majority of this code was writen by ChatGPT (because of my poor coding skills). 

Thus it is not optimized at all, feel free to contact me for suggestions on discord : @darksvenor

The code and description of this mod is in French because chatGPT prompt also was.

## Download 

Get the Simple or Advanced version from the releases.

## How to use the "simple version"

For both RankProfile.js , RankLobby.js and NameSpoofer.js , just put them into your PenguLoader "plugins" file. 


### RankProfile.js

You will need to open the RankProfile.js file in a text editor and find at the begining find the tier and tierText.

tier can have the values for league ranks (gold, platinium, master...) (May be Caps sensitive)

tierText can have any value as it is the text rank shown on your profile page.

lp and wins are the numbers shown on your profile for Solo/Duo. For tiers below master more than 99 lp (obviously) feels strange.



### RankLobby.js 

Open RankLobby.js in your text editor.

Just ignore ProfileIcon and summonerLevel they are useless.

You can change any of the ranks in the begining of the code (Challenger, Diamond...) to any other rank. Even here /lol-game-data/assets/ASSETS/Regalia/BannerSkins/CHALLENGER.png

May be Caps sensitive. 

bannerSrc is the banner behind you in a lobby or the profile. 

crystalLevel is the challenge crystal below your icon.

rankedTier is the border around your icon.

ranked division is NA for master+ and 1-4 for iron-diamond.

Do NOT change crest type or ID.

#### I want a different banner than the ranked ones, how do i do ? 

just go to this website : https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/assets/regalia/bannerskins/

there is every single banner in the game. 

Then you go to your RankLobby.js file and change in bannerSrc the "CHALLENGER.png" (or the rank there is) by the one you want in the website i linked you.


### NameSpoofer.js

Same as before at the begining of the code you will find :

PSEUDO_ACTUEL : your RIOT Nickname WITHOUT your tagline

TAGLINE_ACTUEL : ONLY your tagline 

NOUVEAU_PSEUDO : the name you want WITHOUT the tagline

NOUVEAU_TAGLINE : ONLY the tagline you want 


## How to use Advanced version

only one file in this version 

### Define targeted players

You will have to get the player (you or a friend) PUUID, it can be tricky tho. 

In order to retrieve those puuid follow these steps carefully : 

1) Go to the player's profile
2) Press CTRL+SHIFT+I simultaneously (it should open DevTools)
3) Go to elements tab (should already be in it when you opened DevTools)
4) Press CTRL+F simultaneously
5) Type PUUID into the search bar
6) If you are in YOUR profile, there should only be 1
7) If it is a FRIENDS' profile, there are two results, **PICK THE SECOND ONE** because the first one is your own.

### Replace the placeholders 

When you open the file with notepad or another text software, you should see this at the beginning of the code : 

    "PUUID": {
        tier: 'RANK (MASTER, PLATINUM...) **IN FULL CAPS*
        div: 'division (I II III OR IV)',
        text: 'rank text (put the same value as tier) ',
        wins: number (22, 58 ),
        lp: number of lp for the rank (0-99 before masters tier),
        banner: '/lol-game-data/assets/ASSETS/Regalia/BannerSkins/DIAMOND.png'}, <-- **THIS COMA IS MANDATORY IF YOU PUT MULTIPLE PLAYERS, DO NOT PUT IT AFTER THE LAST ONE**



Replace the puuid with the one you got in the previous step.
The rest is self explainatory. for two players, it should look like this: 



    "71ed307f-1986-5073-8a63-443aa9af787b": {
        tier: 'MASTER',
        div: 'NA',
        text: 'MASTER',
        wins: 22,
        lp: 46,
        banner: '/lol-game-data/assets/ASSETS/Regalia/BannerSkins/DIAMOND.png'}, //<-- **COMA**
    //Username
    "71ed307f-1865-5073-8a63-462aa9af747b": {
        tier: 'IRON',
        div: 'IV',
        text: 'IRON',
        wins: 15414,
        lp: 0,
        banner: '/lol-game-data/assets/ASSETS/Regalia/BannerSkins/IRON.png'} //<-- **NO COMA**



You get it, you put a coma after each player except the last one.

### Pro tips 

Open the file in an IDE such as VS Code if possible, it will show you any errors.

Label the players with //Username just on top of the puuid if you want to modify it later.


## To do

~~Hover Cards feels clunky and is not modified as intended~~ (fixed in the advanced version)

~~Other players profile are also affected by the mod.~~ (fixed in the advanced version)

~~Name spoofer does not work in the chat.~~ Fix Name Spoofer 

Ranked post game rank spoofer (in progress)

## Credits
[Pengu Loader](https://github.com/PenguLoader/PenguLoader) to run all the scripts

[nylish](https://www.youtube.com/watch?v=gU97T9tHs8E&list=PLmfRqBUHwQjJKuxoVOiocEoJPi8SnJSRG&index=3) for the challenger recall

[League Custom Skin](https://github.com/LeagueToolkit/cslol-manager)

[Community Dragon](https://raw.communitydragon.org/) usefull database for all the LoL assets, textures... 
