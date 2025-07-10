// ==UserScript==
// @name         Remplacement complet pseudo + tagline
// @description  Remplace ton pseudo & tagline même dans le chat, tooltips, hover, etc.
// @version      2.0
// ==/UserScript==

(function () {
    'use strict';

    /*** CONFIGURATION ***/
    const PSEUDO_ACTUEL = 'YourName';
    const NOUVEAU_PSEUDO = 'NameUWant';

    const TAGLINE_ACTUEL = 'YourTAG';
    const NOUVEAU_TAGLINE = 'TagUWant';

    /*** UTIL: Nettoyage des caractères invisibles Unicode ***/
    function nettoyerTexte(str) {
        return str.replace(/[\u2066\u2069]/g, '').trim();
    }

    /*** Fonction qui remplace le pseudo et tagline dans tous les nœuds texte du DOM ***/
    function remplacerDansTexteDOM() {
        const xpath = `//text()[contains(., '${PSEUDO_ACTUEL}') or contains(., '${TAGLINE_ACTUEL}')]`;
        const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);

        for (let i = 0; i < result.snapshotLength; i++) {
            const node = result.snapshotItem(i);
            const originalText = nettoyerTexte(node.nodeValue);

            let modifiedText = originalText;

            if (originalText.includes(PSEUDO_ACTUEL)) {
                modifiedText = modifiedText.replaceAll(PSEUDO_ACTUEL, NOUVEAU_PSEUDO);
            }
            if (originalText.includes(TAGLINE_ACTUEL)) {
                modifiedText = modifiedText.replaceAll(TAGLINE_ACTUEL, NOUVEAU_TAGLINE);
            }

            if (modifiedText !== originalText) {
                console.log(`[MODIF] "${originalText}" → "${modifiedText}"`);
                node.nodeValue = modifiedText;
            }
        }
    }

    /*** Observe tous les changements DOM en continu ***/
    const observer = new MutationObserver(() => {
        remplacerDansTexteDOM();
    });

    function start() {
        observer.observe(document.body, { childList: true, subtree: true });
        remplacerDansTexteDOM(); // première passe
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
