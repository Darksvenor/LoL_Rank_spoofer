(function () {
  // === CONFIGURATION ===

  // Rang actuel (affiché sur la bannière du profil et dans le tooltip Solo/Duo)
  const rankData = {
    tier: 'CHALLENGER',      // utilisé pour l'attribut ranked-tier (majuscule)
    tierText: 'CHALLENGER',  // texte visible comme "Gold IV", "Platinum II", etc.
    wins: 296,
    lp: 1084            // shows Challenger 1084 LP , 296 wins 
  };

  // Rang de la saison précédente (dans le tooltip)
  const lastSeasonData = {
    tier: 'CHALLENGER',
    tierText: 'CHALLENGER'
  };

  // === PATCH PROFIL (hors-tooltip) ===
  function patchProfileBanner() {
  const emblemWrappers = document.querySelectorAll('.style-profile-emblem-wrapper');

  emblemWrappers.forEach(wrapper => {
    const title = wrapper.querySelector('.style-profile-emblem-header-title');
    const subtitle = wrapper.querySelector('.style-profile-emblem-header-subtitle');
    const emblem = wrapper.parentElement?.querySelector('lol-regalia-emblem-element');

    // ⚠️ Ne modifier que si le bloc concerne "Solo/Duo"
    if (!title || title.textContent.trim().toLowerCase() !== 'solo/duo') return;

    // 1. Texte du rang : remplacer contenu par tierText
    if (subtitle && rankData.tierText) {
      subtitle.textContent = rankData.tierText;
      console.log('[Pengu] ✏️ Texte du rang (bannière profil) modifié');
    }

    // 2. Emblème : remplacer ranked-tier
    if (emblem) {
      emblem.setAttribute('ranked-tier', rankData.tier);
      const shadowEl = emblem.shadowRoot?.querySelector('.regalia-emblem');
      if (shadowEl) {
        shadowEl.setAttribute('ranked-tier', rankData.tier.toLowerCase());
      }
      console.log('[Pengu] 🛡️ Emblème de profil Solo/Duo mis à jour');
    }
  });
}


  // === PATCH TOOLTIP SOLO/DUO + LAST SEASON ===
  function patchTooltipQueues() {
    const tooltipContainers = document.querySelectorAll('.profile-ranked-emblem-tooltip-container');

    tooltipContainers.forEach(container => {
      const queueBlocks = container.querySelectorAll('.ranked-tooltip-queue, .ranked-tooltip-last-season');

      queueBlocks.forEach(queue => {
        const queueName =
          queue.querySelector('.ranked-tooltip-queue-name')?.textContent?.trim() ||
          queue.querySelector('.ranked-tooltip-last-season-queue-name')?.textContent?.trim();

        const isSoloDuo = queueName === 'Solo/Duo';
        const isLastSeason = queueName === "Last Season's Rank";
        if (!isSoloDuo && !isLastSeason) return;

        const data = isSoloDuo ? rankData : lastSeasonData;

        // 1. Modifier emblème
        const emblemElement = queue.querySelector('lol-regalia-emblem-element[ranked-tier]');
        if (emblemElement) {
          emblemElement.setAttribute('ranked-tier', data.tier);
          const shadowEl = emblemElement.shadowRoot?.querySelector('.regalia-emblem');
          if (shadowEl) {
            shadowEl.setAttribute('ranked-tier', data.tier.toLowerCase());
          }
          console.log(`[Pengu] 🛡️ Emblème patché pour ${queueName}`);
        }

        // 2. Texte du rang
        const tierTextEl =
          queue.querySelector('.ranked-tooltip-queue-tier') ||
          queue.querySelector('.ranked-tooltip-last-season-queue-tier');

        if (tierTextEl) {
          tierTextEl.textContent = data.tierText;
        }

        // 3. Si Solo/Duo : LP/Victoires
        if (isSoloDuo) {
          let lpBlock = queue.querySelector('.style-profile-ranked-crest-tooltip-lp');
          const html = `<span>${rankData.wins}</span> Wins <span>${rankData.lp}</span> LP`;

          if (!lpBlock) {
            lpBlock = document.createElement('div');
            lpBlock.className = 'style-profile-ranked-crest-tooltip-lp';
            lpBlock.innerHTML = html;
            if (tierTextEl && tierTextEl.parentNode) {
              tierTextEl.parentNode.insertBefore(lpBlock, tierTextEl.nextSibling);
              console.log(`[Pengu] ➕ LP/Victoires ajoutés à ${queueName}`);
            }
          } else {
            const spans = lpBlock.querySelectorAll('span');
            if (spans.length >= 2) {
              spans[0].textContent = rankData.wins;
              spans[1].textContent = rankData.lp;
            } else {
              lpBlock.innerHTML = html;
            }
            console.log(`[Pengu] 🏆 LP/Victoires mis à jour pour ${queueName}`);
          }
        }
      });
    });
  }

  // === OBSERVER + INTERVAL ===
  const observer = new MutationObserver(() => {
    patchTooltipQueues();
    patchProfileBanner();
  });

  window.addEventListener('load', () => {
    observer.observe(document.body, { childList: true, subtree: true });

    let attempts = 0;
    const maxAttempts = 30;
    const interval = setInterval(() => {
      patchTooltipQueues();
      patchProfileBanner();
      attempts++;
      if (attempts >= maxAttempts) {
        clearInterval(interval);
        console.log('[Pengu] ✅ Patch complet terminé');
      }
    }, 300);
  });
})();
