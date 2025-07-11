# LoL_Rank_spoofer
A tool to change your rank thoughout the whole LoL client (and game)

## Disclaimer 
This mod is only visible to you and only visual, your friends and other players wont see the changes this mod makes.

This mod is provided "as is" and i can't be held responsible for any damage it may cause.

The vast majority of this code was writen by ChatGPT (because of my poor coding skills). 

Thus it is not optimized at all, feel free to contact me for suggestions on discord : @darksvenor

The code and description of this mod is in French because chatGPT prompt also was.

## How to use 

For both RankProfile.js , RankLobby.js and NameSpoofer.js , just put them into your PenguLoader "plugins" file. 


### RankProfile.js

You will need to open the RankProfile.js file in a text editor and find at the begining find the tier and tierText.

tier can have the values for league ranks (gold, platinium, master...) (May be Caps sensitive)

tierText can have any value as it is the text rank shown on your profile page.

lp and wins are the numbers shown on your profile for Solo/Duo. For tiers below master more than 99 lp (of course) feels strange.



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

#### I do want a different banner than the ranked ones, how do i do ? 

just go to this website : https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/assets/regalia/bannerskins/

there is every single banner in the game. 

Then you go to your RankLobby.js file and change in bannerSrc the "CHALLENGER.png" (or the rank there is) by the one you want in the website i linked you.


### NameSpoofer.js

Same as before at the begining of the code you will find :

PSEUDO_ACTUEL : your RIOT Nickname WITHOUT your tagline

TAGLINE_ACTUEL : ONLY your tagline 

NOUVEAU_PSEUDO : the name you want WITHOUT the tagline

NOUVEAU_TAGLINE : ONLY the tagline you want 

## To do

Hover Cards feels clunky and is not modified as intended 

Other players profile are also affected by the mod. 

Name spoofer does not work in the chat. 
## Credits
[Pengu Loader](https://github.com/PenguLoader/PenguLoader) to run all the scripts

[nylish](https://www.youtube.com/watch?v=gU97T9tHs8E&list=PLmfRqBUHwQjJKuxoVOiocEoJPi8SnJSRG&index=3) for the challenger recall

[League Custom Skin](https://github.com/LeagueToolkit/cslol-manager)

[Community Dragon](https://raw.communitydragon.org/) usefull database for all the LoL assets, textures... 
