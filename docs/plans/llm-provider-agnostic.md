# Feature-Rec : support de n'importe quelle clé LLM

Oct 6, 2026 · @ryad

## Objectif et périmètre

Un client doit pouvoir faire tourner Feature-Rec avec une clé Anthropic, OpenAI, OpenRouter ou n'importe quelle API compatible OpenAI, sans rien changer pour les clients actuels. C'est aussi ce qui rendra vraie la promesse « model-agnostic » du site.

Le choix le plus simple qui couvre presque tout le marché : **deux implémentations seulement**. Anthropic garde son SDK natif, et tout le reste passe par un seul client « compatible OpenAI » avec une `baseURL` configurable. Ce format est supporté par OpenAI, OpenRouter, Mistral, Groq, Together, DeepSeek, Gemini (endpoint OpenAI-compatible) et les proxys type LiteLLM ou vLLM.

**Dans le périmètre**

- Les 2 appels LLM de l'Action : le classifieur et l'agent de génération de scène.
- La configuration côté workflow client (variables d'env et inputs de l'Action).
- La rétrocompatibilité totale avec `ANTHROPIC_API_KEY` seul.
- Les tests, la doc et l'exemple de workflow.

**Hors périmètre (volontairement)**

- Le backend : il n'appelle aucun LLM, il ne bouge pas.
- Streaming, tool use, prompt caching : non utilisés aujourd'hui.
- SDK natifs Gemini, Bedrock, Vertex, Azure OpenAI : accessibles plus tard via un proxy compatible OpenAI si besoin.
- Améliorer le retry ou la boucle de correction de la génération : c'est une autre tâche (fiabilisation du rendu).

## État actuel du code

Le LLM n'est appelé qu'à deux endroits, tous deux sur le runner GitHub du client, avec `@anthropic-ai/sdk` en direct. Source : la synthèse de Claude Code sur `Hanibzd/Feature-Rec` (commit `618b513`).

| Appel | Fichier / fonction | Modèle | Sortie attendue |
| --- | --- | --- | --- |
| Classifieur « frontend-visible » | `packages/action/src/classifier.ts`, `classifyFrontendVisible` | `FEATURE_REC_MODEL` → `AUTODEMO_MODEL` → `claude-sonnet-4-6` | JSON strict, parsé par `extractClassifierJson`, validé par `ClassifierResultSchema` |
| Agent de réplication (scène Remotion) | `packages/cli/src/agent/anthropic.ts`, `callClaude` (appelé par `replicate` dans `agent/index.ts`) | `AUTODEMO_MODEL` → `claude-sonnet-4-6`, `AUTODEMO_MAX_TOKENS` = 16 000 | 4 sections de spec + un bloc \`\`\`tsx, validé par regex dans `agent/validate.ts` |

Comportements à conserver :

- Sans clé, le classifieur bascule sur `heuristicFrontendVisible` (`action/src/diff.ts`). Si un candidat UI est trouvé sans `FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER=1`, le run échoue.
- `FEATURE_REC_OFFLINE=1` force les scènes « known-good » sans appel LLM.
- Les prompts vivent dans `packages/cli/src/agent/prompt.ts` (`SYSTEM_PROMPT`, `INTEGRATION_CONTRACT`, `CHOREOGRAPHY`, `buildUserPrompt`) et inline dans `classifier.ts`. Ils ne changent pas.
- `ANTHROPIC_API_KEY` est un secret du repo client passé à l'Action composite (`packages/action/action.yaml`).
- Toute exception finit dans `failCycle`, qui envoie le message et la stack trace dans le check run visible sur la PR. Aucun message d'erreur ne doit donc contenir la clé.

## Design retenu

Une seule fonction `complete()` derrière une petite interface, deux implémentations, et les deux call sites l'appellent au lieu du SDK Anthropic. Pas de Vercel AI SDK ni de LangChain : on n'a besoin que d'un appel texte → texte, une dépendance légère suffit.

```ts
export type LlmProvider = "anthropic" | "openai" | "openrouter" | "openai-compatible";

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  baseURL?: string;          // obligatoire pour "openai-compatible"
  model: string;             // modèle de génération de scène
  classifierModel: string;   // par défaut = model
  maxTokens: number;         // 16 000 par défaut
  timeoutMs: number;
}

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  model: string;
}

export interface LlmResponse {
  text: string;
  truncated: boolean;        // stop_reason "max_tokens" / finish_reason "length"
  usage?: { inputTokens: number; outputTokens: number };
  provider: LlmProvider;
  model: string;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export function resolveLlmConfig(env: NodeJS.ProcessEnv): LlmConfig | null; // null = aucune clé
export function createLlmClient(config: LlmConfig): LlmClient;
```

**Où mettre le code : un nouveau package `packages/llm` (`@feature-rec/llm`).** Les deux call sites sont dans deux packages différents (`action` et `cli`), donc le module doit être partagé. Il ne faut **pas** le mettre dans `core` : `core` est embarqué dans l'image Docker du backend, qui n'a aucun besoin des SDK LLM.

Contenu du package :

- `src/config.ts` : `resolveLlmConfig`, fonction pure, testée sans réseau.
- `src/anthropic.ts` : implémentation via `@anthropic-ai/sdk` (le code actuel de `callClaude`, déplacé).
- `src/openai.ts` : implémentation via le package npm `openai`, utilisée pour `openai`, `openrouter` et `openai-compatible`.
- `src/index.ts` : `createLlmClient`, qui choisit l'implémentation selon `provider`.

`@anthropic-ai/sdk` déménage de `cli` vers `llm`. `action` et `cli` dépendent de `@feature-rec/llm` (`workspace:*`). `callClaude` est renommé `callLlm`.

## Configuration

Le code ne lit que des variables d'environnement. L'Action expose les mêmes réglages en `inputs`, que `action.yaml` recopie en variables d'env, et un input renseigné l'emporte sur la variable d'env.

| Variable d'env | Input de l'Action | Rôle | Défaut |
| --- | --- | --- | --- |
| `FEATURE_REC_LLM_PROVIDER` | `llm-provider` | `anthropic`, `openai`, `openrouter` ou `openai-compatible` | auto-détecté (voir plus bas) |
| `FEATURE_REC_LLM_API_KEY` | `llm-api-key` | clé générique, quel que soit le fournisseur | — |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | — | clés spécifiques, lues si la clé générique est vide | — |
| `FEATURE_REC_LLM_BASE_URL` | `llm-base-url` | URL de l'API compatible OpenAI | `https://api.openai.com/v1` pour `openai`, `https://openrouter.ai/api/v1` pour `openrouter`, obligatoire pour `openai-compatible` |
| `FEATURE_REC_MODEL` | `model` | modèle utilisé pour les deux appels | `claude-sonnet-4-6` pour `anthropic`, **obligatoire** pour les autres |
| `FEATURE_REC_CLASSIFIER_MODEL` | `classifier-model` | modèle plus léger pour le classifieur, optionnel | = `FEATURE_REC_MODEL` |
| `FEATURE_REC_MAX_TOKENS` | `max-tokens` | plafond de sortie de la génération de scène | 16 000 |
| `FEATURE_REC_LLM_TIMEOUT_MS` | — | timeout par appel | 600 000 (10 min) |

`AUTODEMO_MODEL` et `AUTODEMO_MAX_TOKENS` restent lus comme alias dépréciés, avec un warning dans les logs.

**Ordre de résolution dans `resolveLlmConfig`**

1. Fournisseur : `FEATURE_REC_LLM_PROVIDER` s'il est défini. Sinon auto-détection par la première clé présente dans cet ordre : `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`. Anthropic passe en premier pour ne rien changer aux clients actuels. Si plusieurs clés sont présentes, logger lequel a été choisi.
2. Clé : `FEATURE_REC_LLM_API_KEY`, sinon la clé spécifique du fournisseur.
3. Aucune clé et aucun fournisseur explicite : retourner `null`, ce qui garde exactement le comportement actuel (heuristique).
4. Fournisseur explicite mais pas de clé : **erreur claire**, pas de bascule silencieuse sur l'heuristique.
5. `openai-compatible` sans `FEATURE_REC_LLM_BASE_URL`, ou fournisseur autre qu'Anthropic sans `FEATURE_REC_MODEL` : erreur claire qui dit quelle variable ajouter. On ne devine pas de nom de modèle par défaut pour OpenAI ou OpenRouter, ils deviennent obsolètes trop vite.
6. `FEATURE_REC_MAX_TOKENS` doit être un entier positif, sinon erreur.

**Exemple de workflow client avec OpenRouter**

```yaml
- uses: Hanibzd/Feature-Rec/packages/action@main
  with:
    llm-provider: openrouter
    llm-api-key: ${{ secrets.OPENROUTER_API_KEY }}
    model: <id du modèle sur OpenRouter>
```

Un client actuel qui ne passe que `ANTHROPIC_API_KEY` n'a **rien** à changer.

## Différences entre fournisseurs à gérer

Toute la complexité est dans ces détails, et ils doivent rester enfermés dans `packages/llm` : les call sites ne voient qu'un `LlmResponse` propre.

| Point | Anthropic | Compatible OpenAI | Ce que fait `packages/llm` |
| --- | --- | --- | --- |
| Prompt système | paramètre `system` | message `{role: "system"}` en tête | accepte `system` + `user`, construit le bon format |
| Plafond de sortie | `max_tokens` | `max_completion_tokens` chez OpenAI (les modèles récents refusent `max_tokens`), `max_tokens` chez OpenRouter et la plupart des autres | `max_completion_tokens` si `provider === "openai"`, sinon `max_tokens` |
| Température | acceptée | refusée par les modèles à raisonnement | ne pas l'envoyer pour les fournisseurs compatibles OpenAI. Vérifier si le code actuel en envoie une |
| Prefill (dernier message `assistant`) | supporté | pas supporté | vérifier si `callClaude` en utilise un. Si oui, le remplacer par une consigne dans le prompt pour tous les fournisseurs |
| Lecture du texte | blocs `content` de type `text` | `choices[0].message.content`, parfois `null` ou vide | concaténer les blocs texte. Contenu vide = erreur explicite |
| Raisonnement visible | — | certains modèles renvoient `<think>…</think>` dans le contenu | retirer ces balises avant de rendre le texte, sinon un bloc de code dans le raisonnement peut être pris pour la scène |
| Sortie tronquée | `stop_reason: "max_tokens"` | `finish_reason: "length"` | `truncated: true`, et l'agent lève une erreur claire qui suggère `FEATURE_REC_MAX_TOKENS`, au lieu d'un échec de validation incompréhensible |
| Plafond de sortie du modèle | 16 000 OK sur Sonnet | certains modèles plafonnent plus bas et répondent 400 | message d'erreur qui cite le modèle et `FEATURE_REC_MAX_TOKENS` |
| JSON du classifieur | pas de mode JSON utilisé | `response_format` pas supporté partout | ne rien changer : garder le parsing tolérant `extractClassifierJson` pour tous |
| Retries et timeout | SDK : retry 429/5xx | SDK `openai` : idem | `maxRetries: 2` et `timeout` explicites sur les deux clients |
| En-têtes OpenRouter | — | `HTTP-Referer` et `X-Title` optionnels | envoyer `X-Title: Feature-Rec` et `HTTP-Referer: https://feature-rec.com` quand `provider === "openrouter"` |

**Sécurité de la clé.** Dans l'Action, appeler `core.setSecret(apiKey)` dès la résolution pour que GitHub la masque dans les logs. Les erreurs du SDK sont réécrites en un message court (fournisseur, modèle, code HTTP, message de l'API) sans en-têtes ni objet de config, parce que `failCycle` affiche l'erreur sur la PR.

**Usage.** Logger une ligne par appel avec fournisseur, modèle, tokens en entrée et en sortie, et durée. Ce sera la base des métriques plus tard.

## Plan d'implémentation

Une seule PR sur une branche `feat/llm-provider-agnostic`, en 7 étapes. Chaque étape doit laisser le typecheck, le lint et les selftests au vert.

1. **Lire avant d'écrire.** Relire `classifier.ts`, `agent/anthropic.ts`, `agent/index.ts`, `prompt.ts`, `action.yaml`, `examples/feature-rec-workflow.yaml`. Noter ce que l'appel actuel envoie vraiment (température, prefill, stop sequences, format des messages). Les résultats décident de deux lignes du tableau des pièges.
2. **Créer `packages/llm`.** `package.json` (`@feature-rec/llm`, ESM, même config TS et ESLint que les autres packages), dépendances `@anthropic-ai/sdk` (même version qu'aujourd'hui) et `openai` (version exacte figée). Ajouter le package là où le typecheck et le lint de la CI le prendront.
3. **Implémenter** `config.ts`, `anthropic.ts`, `openai.ts`, `index.ts` selon les sections Design, Configuration et Pièges.
4. **Brancher le classifieur.** Dans `classifyFrontendVisible`, remplacer l'appel Anthropic par `createLlmClient(config).complete(...)` avec `classifierModel`. Si `resolveLlmConfig` renvoie `null`, garder exactement le chemin heuristique actuel.
5. **Brancher l'agent.** Remplacer `callClaude` par `callLlm` dans `cli/src/agent`, en passant `model` et `maxTokens`. Lever une erreur claire si `truncated`. Ne pas toucher aux prompts ni à `validate.ts`. `FEATURE_REC_OFFLINE=1` continue de court-circuiter tout appel.
6. **Brancher l'Action.** Ajouter les inputs dans `action.yaml` et les recopier en variables d'env (en ne définissant la variable que si l'input est renseigné, pour ne pas écraser une variable d'env existante par une chaîne vide). Appeler `core.setSecret` sur la clé résolue.
7. **Lockfile et nettoyage.** Lancer `pnpm install` pour mettre à jour `pnpm-lock.yaml` et le committer : l'Action fait `pnpm install --frozen-lockfile`, un lockfile périmé casse **tous** les clients. Retirer `@anthropic-ai/sdk` des packages qui ne l'utilisent plus. Vérifier que `docker build` du backend passe toujours (il ne doit pas embarquer `packages/llm`).

Documentation à mettre à jour dans la même PR : README (section configuration + modèles testés), `docs/product.md`, `examples/feature-rec-workflow.yaml` (exemple Anthropic + exemple OpenRouter en commentaire).

## Tests, qualité et déploiement

Le vrai risque n'est pas le code, c'est que la génération de scènes Remotion de 16 000 tokens marche bien avec Claude et mal avec d'autres modèles. Et comme les clients pointent sur `@main`, un merge raté casse tout le monde d'un coup.

**Tests automatiques (CI, sans réseau)**, dans le style du repo : un script `packages/llm/scripts/selftest.mts` exécuté par `tsx` avec assertions maison, ajouté aux selftests de la CI.

- `resolveLlmConfig` : chaque ligne de l'ordre de résolution, dont « `ANTHROPIC_API_KEY` seule » (doit donner exactement la config d'aujourd'hui), « aucune clé » (`null`), « fournisseur sans clé », « `openai-compatible` sans base URL », « OpenRouter sans modèle », alias `AUTODEMO_*`, `FEATURE_REC_MAX_TOKENS` invalide.
- Normalisation des réponses avec des objets factices : contenu `null`, balises `<think>`, troncature, concaténation des blocs texte.
- Construction des requêtes : `max_completion_tokens` pour OpenAI, `max_tokens` ailleurs, pas de température côté compatible OpenAI, en-têtes OpenRouter.
- Un message d'erreur construit à partir d'une fausse erreur 401 ne contient jamais la clé.

**Éval manuelle (vrais appels, hors CI)** sur les deux fixtures `dark-mode-toggle` et `invite-members`, avec la CLI locale : pour chaque fournisseur, la scène passe-t-elle `validateScene`, le MP4 se rend-il, et la vidéo ressemble-t-elle au composant ? Le résultat va dans un tableau « modèles testés » du README.

**Déploiement sans casser la prod**

1. Ne pas merger tout de suite. Dans `feature-rec-test-repo`, faire pointer le workflow sur `Hanibzd/Feature-Rec/packages/action@feat/llm-provider-agnostic`.
2. Ouvrir une vraie PR UI dans le repo de test avec `ANTHROPIC_API_KEY` seul : le flow doit être identique à aujourd'hui (non-régression).
3. Refaire la même PR avec OpenAI, puis avec OpenRouter : check run, vidéo dans Slack, clic sur un bouton.
4. Tester une PR non UI pour vérifier l'auto-accept via le classifieur avec un autre fournisseur.
5. Seulement après, merger dans `main` et remettre le workflow du repo de test sur `@main`. En cas de problème : revert du commit de merge.

## Critères d'acceptation et prompt pour Claude Code

La tâche est finie quand toutes ces cases sont cochées.

- [ ] Un client avec seulement `ANTHROPIC_API_KEY` obtient exactement le même comportement qu'avant (même modèle, mêmes prompts, même flow).
- [ ] Une PR UI du repo de test produit une vidéo dans Slack avec OpenAI, et avec OpenRouter.
- [ ] Aucune clé et aucun fournisseur : comportement heuristique inchangé.
- [ ] Chaque erreur de config (clé manquante, base URL manquante, modèle manquant, max tokens invalide) affiche un message qui dit quoi ajouter.
- [ ] Une sortie tronquée donne une erreur explicite, pas un échec de validation.
- [ ] La clé n'apparaît jamais dans les logs ni dans le check run.
- [ ] Plus aucun import de `@anthropic-ai/sdk` en dehors de `packages/llm`.
- [ ] CI verte : typecheck, lint, selftests (dont le nouveau), build Docker du backend.
- [ ] `pnpm-lock.yaml` à jour et committé.
- [ ] README, `docs/product.md` et l'exemple de workflow à jour, avec le tableau des modèles testés.

**Prompt à coller dans Claude Code** (avec ce doc exporté en Markdown et posé à la racine du repo sous `docs/plans/llm-provider-agnostic.md`) :

```
Lis docs/plans/llm-provider-agnostic.md en entier : c'est la spec de ma tâche.

Étape 1 : fais uniquement l'étape « Lire avant d'écrire » du plan. Dis-moi ce que les appels actuels envoient vraiment (température, prefill, stop sequences, format des messages, gestion des erreurs) et si quelque chose dans la spec ne colle pas au code. N'écris rien tant que je n'ai pas validé.

Étape 2, après ma validation : crée la branche feat/llm-provider-agnostic et implémente les étapes 2 à 7 dans l'ordre. Après chaque étape, lance typecheck, lint et selftests, et fais un commit séparé.

Règles :
- Ne modifie ni les prompts ni validate.ts.
- Ne touche pas au backend (packages/service).
- N'affiche jamais une clé ou un secret, même partiellement.
- Si un choix n'est pas couvert par la spec, demande-moi au lieu de deviner.

À la fin, donne-moi la checklist des critères d'acceptation avec ce qui est vérifié et ce qui reste à tester à la main (éval sur les fixtures, PRs réelles sur le repo de test).
```

## Revue du plan contre le code (commit `618b513`)

Constats de l'étape « Lire avant d'écrire ». Statut : **résolu** = décision prise et intégrée à l'implémentation ; **ouvert** = reste à vérifier.

**Ce que les appels envoient aujourd'hui.** Les deux appels utilisent `new Anthropic()` sans options (clé via `ANTHROPIC_API_KEY`, `maxRetries` 2 et timeout 10 min par défaut du SDK), un `system` en chaîne et un unique message `user`. Aucune température, aucun `top_p`, aucune stop sequence, aucun prefill. Les lignes « Température » et « Prefill » du tableau des pièges n'impliquent donc aucun changement de prompt.

1. **Résolu.** `@anthropic-ai/sdk` est une dépendance de `packages/action` (classifieur) en plus de `packages/cli`. Il est retiré des deux.
2. **Résolu (changement de comportement assumé).** L'agent lisait uniquement `AUTODEMO_MODEL` ; le classifieur lisait `FEATURE_REC_MODEL` puis `AUTODEMO_MODEL`. Désormais `FEATURE_REC_MODEL` l'emporte pour les deux appels et `AUTODEMO_MODEL` est un alias déprécié. Un client qui définit les deux variables avec des valeurs différentes voit le modèle de génération changer. À signaler dans la description de la PR.
3. **Résolu.** Le classifieur a un plafond propre de 1 200 tokens et sa propre erreur de troncature. Conservés tels quels.
4. **Résolu.** Une sortie tronquée de l'agent est interceptée par `replicate`, qui bascule sur la scène known-good si elle existe (comportement conservé). Sans scène known-good, l'erreur d'origine (troncature avec l'indice `FEATURE_REC_MAX_TOKENS`, ou erreur du fournisseur) remonte telle quelle jusqu'au check run.
5. **Résolu.** Les messages qui nommaient `ANTHROPIC_API_KEY` en dur (erreur du classifieur, `reason` de l'heuristique, logs de `replicate`, dépannage de l'onboarding) deviennent génériques et listent les variables de clé acceptées.
6. **Résolu.** La configuration est documentée dans `docs/tenant-onboarding.md` et `.env.example`, absents de la liste de la spec. Ajoutés au périmètre doc.
7. **Résolu.** Le script racine `selftest` liste les packages en dur : `@feature-rec/llm` y est ajouté. Typecheck (`pnpm -r`) et lint (`packages/**`) le prennent automatiquement.
8. **Résolu.** Le Dockerfile ne copie que `core` et `service` (`--filter @feature-rec/service...`) : `packages/llm` n'est pas embarqué, rien à changer.
9. **Résolu.** Le SDK Anthropic honore `ANTHROPIC_BASE_URL` quand aucun `baseURL` n'est passé ; ce comportement est conservé. `FEATURE_REC_LLM_BASE_URL` ne s'applique qu'à la famille compatible OpenAI.
10. **Résolu.** Les nouveaux inputs de `action.yaml` passent par `env:` de l'étape et un `export` conditionnel en bash ; la clé n'est jamais interpolée dans le texte du script.

**Décisions sur les points non couverts par la spec.**

- `FEATURE_REC_LLM_API_KEY` seule, sans fournisseur ni clé spécifique : erreur qui demande de définir `FEATURE_REC_LLM_PROVIDER`.
- Fournisseur inconnu : erreur qui liste les valeurs acceptées. `FEATURE_REC_LLM_TIMEOUT_MS` et `AUTODEMO_MAX_TOKENS` doivent être des entiers positifs (l'alias était auparavant ignoré silencieusement s'il était invalide).
- Warnings de dépréciation et log « plusieurs clés » émis une seule fois par processus (l'Action résout la config pour le classifieur puis pour l'agent).
- `ReplicationSource` `"anthropic"` renommé en `"llm"`.
- Une erreur HTTP 400 de l'agent ajoute un indice qui cite le modèle et `FEATURE_REC_MAX_TOKENS` ; pas sur le classifieur, dont le plafond n'est pas configurable.
- `openai` figé à la dernière version stable au moment de l'ajout.
- Tableau « modèles testés » du README : `claude-sonnet-4-6` en référence, les autres « à tester ».

**Ouvert.** Éval manuelle sur les fixtures et PRs réelles dans le repo de test (voir « Tests, qualité et déploiement »).
