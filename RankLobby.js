(function () {
  // === CONFIGURATION SIMULÉE JSON ===
  const crestConfig = {
    bannerSrc: '/lol-game-data/assets/ASSETS/Regalia/BannerSkins/CHALLENGER.png',
    profileIcon: '/lol-game-data/assets/v1/profile-icons/29.jpg',
    summonerLevel: '1',
    crystalLevel: 'DIAMOND',
    prestigeCrestId: '23',
    rankedTier: 'CHALLENGER',
    rankedDivision: 'NA',
    rankedSplitReward: '0',
    crestType: 'ranked'
  };

  // === SCRIPT PRINCIPAL ===

  function isInsideOtherPlayer(el) {
    while (el) {
      if (el.outerHTML && el.outerHTML.includes('other-player')) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  function patchBanner(el) {
    if (isInsideOtherPlayer(el)) return false;

    if (el.tagName === 'IMG' && el.classList.contains('regalia-banner-asset-static-image')) {
      const src = el.getAttribute('src') || '';
      if (!src.includes('challenger.png')) {
        el.setAttribute('src', crestConfig.bannerSrc);
        el.setAttribute('data-patched', 'true');
        console.log('[Pengu] ✅ Bannière remplacée par challenger.png');
        return true;
      }
    }
    return false;
  }

  function patchCrest(el) {
    if (isInsideOtherPlayer(el)) return false;

    const icon = el.getAttribute('profile-icon-url');
    const level = el.getAttribute('summoner-level');

    console.log('[Pengu] patchCrest sur élément:', el, 'icon:', icon, 'level:', level);

    el.setAttribute('class', 'regalia-profile-crest-element regalia-crest-loaded');
    el.setAttribute('crest-sizing', 'huge');
    el.setAttribute('animations', 'true');
    el.setAttribute('crystal-level', crestConfig.crystalLevel);
    el.setAttribute('prestige-crest-id', crestConfig.prestigeCrestId);
    el.setAttribute('ranked-tier', crestConfig.rankedTier);
    el.setAttribute('ranked-division', crestConfig.rankedDivision);
    el.setAttribute('ranked-split-reward', crestConfig.rankedSplitReward);
    el.setAttribute('crest-type', crestConfig.crestType);

    if (!icon || icon.trim() === '') {
      el.setAttribute('profile-icon-url', crestConfig.profileIcon);
      console.log('[Pengu] ✅ Icône manquante — forcée par défaut');
    }

    if (!level || level.trim() === '') {
      el.setAttribute('summoner-level', crestConfig.summonerLevel);
      console.log('[Pengu] ✅ Niveau manquant — forcé par défaut');
    }

    el.setAttribute('data-patched', 'true');
    console.log('[Pengu] ✅ Crest modifié en CHALLENGER (sauf icône conservée)');
    return true;
  }

  function recursiveScan(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return false;

    let patchedSomething = false;

    root.querySelectorAll('img.regalia-banner-asset-static-image').forEach(el => {
      if (patchBanner(el)) patchedSomething = true;
    });

    root.querySelectorAll('lol-regalia-crest-v2-element').forEach(el => {
      if (patchCrest(el)) patchedSomething = true;
    });

    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) {
        if (recursiveScan(el.shadowRoot)) patchedSomething = true;
      }
    });

    return patchedSomething;
  }

  const observer = new MutationObserver(() => {
    recursiveScan(document);
  });

  window.addEventListener('DOMContentLoaded', () => {
    observer.observe(document, { childList: true, subtree: true });

    let attempts = 0;
    const maxAttempts = 20;
    const interval = 300;

    const intervalId = setInterval(() => {
      attempts++;
      const patched = recursiveScan(document);
      if (!patched || attempts >= maxAttempts) {
        clearInterval(intervalId);
        console.log('[Pengu] 🛠️ Fin des tentatives de patch');
      }
    }, interval);
  });
})();
