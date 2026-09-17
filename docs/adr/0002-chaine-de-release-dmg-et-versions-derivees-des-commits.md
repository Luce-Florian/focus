# ADR 0002 — Chaîne de release : image disque macOS et version dérivée des commits

- **Statut** : accepté
- **Date** : 2026-09-17
- **Portée** : `electron-builder.yml`, `.github/workflows/`, `commitlint.config.js`,
  `.husky/commit-msg`, `release-please-config.json`, `src/main/index.ts`

## Contexte

Le projet ne se distribuait pas : la seule façon de l'utiliser était de cloner
le dépôt et de lancer `make start`. Trois manques bloquent la diffusion, même
interne :

1. **aucun artefact** — pas de `.dmg`, donc rien à donner à quelqu'un qui ne
   veut pas d'un checkout et d'un `npm install` ;
2. **aucune version** — `package.json` est figé à `1.0.0`, aucun tag git
   n'existe, et rien ne relie une binaire livrée à un commit ;
3. **aucune contrainte sur l'historique** — la convention Conventional Commits
   est respectée de fait depuis le premier commit, mais rien ne l'impose, donc
   rien ne peut s'appuyer dessus.

Le troisième point commande les deux autres : si l'historique est régulier, la
version n'a plus à être écrite à la main.

## Décision

### 1. La version se calcule, elle ne se saisit pas

`release-please` lit les commits arrivés sur `main` et ouvre une *release pull
request* qui porte le bump de `package.json` et le `CHANGELOG.md`. Tant qu'elle
reste ouverte, rien n'est publié : elle est le point de revue humaine. Son
merge pose le tag `vX.Y.Z` et crée la GitHub Release.

L'alternative `semantic-release` publie directement à chaque push sur `main`.
Elle a été écartée pour cette raison : sur un outil qu'une poignée de personnes
installent à la main, voir la version avant qu'elle sorte vaut plus que le run
économisé.

### 2. La convention de commit est vérifiée deux fois

| garde | quand | contournable |
|---|---|---|
| `.husky/commit-msg` | à l'écriture du commit | oui — `--no-verify`, ou un clone où `npm install` n'a pas tourné |
| job `commits` de `check.yml` | sur chaque pull request | non |

Le hook local donne le retour immédiat ; la CI est le garde-fou réel. Un sujet
mal formé n'est pas une faute de style : c'est une version qui ne sera jamais
incrémentée.

### 3. L'artefact est un `.dmg` arm64 signé ad-hoc

`electron-builder` n'embarque que `dist/` et `package.json` : esbuild a déjà
inliné chaque dépendance, y compris xterm.js, donc aucun `node_modules` ne part
dans l'image. Les tests et les source maps sont exclus.

Aucun certificat Developer ID n'est en jeu. La signature ad-hoc (`identity: '-'`)
est le minimum que réclame Apple Silicon pour qu'une application démarre ; le
hardened runtime est désactivé, puisqu'il ne sert qu'à la notarisation et que
sa validation de bibliothèques refuse les frameworks d'Electron sous signature
ad-hoc. Conséquence assumée : macOS met l'image téléchargée en quarantaine, et
la première ouverture passe par un clic droit ou un `xattr -dr
com.apple.quarantine`.

### 4. Installée, l'application ne vit plus dans le dépôt

Deux hypothèses du code ne tenaient qu'en développement, et sont corrigées dans
`src/main/index.ts` :

- `run/` était calculé à partir de la racine du dépôt. Empaquetée, cette racine
  est à l'intérieur d'un `app.asar` en lecture seule : les fichiers `--settings`
  et `fleet.db` vont désormais dans `userData`, et `assertProjectRoot` ne
  s'exécute plus que hors paquet, où elle a un sens.
- `PATH` était celui du terminal. Lancée depuis le Finder, une application
  macOS hérite de `/usr/bin:/bin:/usr/sbin:/sbin`, où ni `tmux` ni `claude`
  n'existent : le `PATH` du shell de login est lu une fois au démarrage,
  uniquement en build empaqueté. Une liste de préfixes devinés (Homebrew, nvm,
  `~/.local/bin`) aurait couvert la machine de l'auteur et pas celle du
  voisin.

## Conséquences

- La seule action manuelle d'une release est le merge d'une pull request.
- `make package` produit localement la même image que la CI.
- Un commit hors convention est refusé, y compris pour un correctif pressé.
- L'image n'est pas notarisée : toute diffusion hors machine de développement
  demande le geste de quarantaine. Repasser à un vrai certificat ne change que
  `mac.identity`, `mac.hardenedRuntime` et les secrets du workflow.
- La CI exécute `make check` sur Ubuntu, où tmux est installé par `apt` et se
  trouve donc en 3.4, quand le développement se fait en 3.6. Le mode contrôle
  utilisé ici est stable entre ces versions, mais c'est le premier endroit à
  regarder si le smoke test diverge entre local et CI.
