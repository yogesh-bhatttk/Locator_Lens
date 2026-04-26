# Graph Report - .  (2026-04-26)

## Corpus Check
- 40 files · ~234,866 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 56 nodes · 78 edges · 17 communities detected
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 3 edges (avg confidence: 0.9)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Locator Generation Logic|Locator Generation Logic]]
- [[_COMMUNITY_Sidepanel Framework UI|Sidepanel Framework UI]]
- [[_COMMUNITY_Inspection Overlay & Injection|Inspection Overlay & Injection]]
- [[_COMMUNITY_DOM Tree Navigation|DOM Tree Navigation]]
- [[_COMMUNITY_Extension Popup UI|Extension Popup UI]]
- [[_COMMUNITY_Results Rendering Helpers|Results Rendering Helpers]]
- [[_COMMUNITY_Framework Translators|Framework Translators]]
- [[_COMMUNITY_Background Messaging Relay|Background Messaging Relay]]
- [[_COMMUNITY_Interaction Event Handling|Interaction Event Handling]]
- [[_COMMUNITY_Decommissioning Logic|Decommissioning Logic]]
- [[_COMMUNITY_Sidepanel Inspection Toggle|Sidepanel Inspection Toggle]]
- [[_COMMUNITY_Clipboard Helpers|Clipboard Helpers]]
- [[_COMMUNITY_Shadow DOM Engine|Shadow DOM Engine]]
- [[_COMMUNITY_Lumina Cyber HUD Concept|Lumina Cyber HUD Concept]]
- [[_COMMUNITY_Distribution Architecture|Distribution Architecture]]
- [[_COMMUNITY_State Sync Shield|State Sync Shield]]
- [[_COMMUNITY_Selector Lab Feature|Selector Lab Feature]]

## God Nodes (most connected - your core abstractions)
1. `generateLocators()` - 10 edges
2. `findUniqueParent()` - 5 edges
3. `updateOverlay()` - 4 edges
4. `getRole()` - 4 edges
5. `getAccessibleName()` - 4 edges
6. `isUnstableId()` - 4 edges
7. `onClick()` - 4 edges
8. `onKeyDown()` - 4 edges
9. `stopInspect()` - 4 edges
10. `getDeepElementAt()` - 3 edges

## Surprising Connections (you probably didn't know these)
- `Universal Framework Matrix` --uses--> `Playwright Translator`  [INFERRED]
  README.md → src/sidepanel.js
- `Universal Framework Matrix` --uses--> `Selenium Translator`  [INFERRED]
  README.md → src/sidepanel.js
- `Universal Framework Matrix` --uses--> `Cypress Translator`  [INFERRED]
  README.md → src/sidepanel.js

## Communities

### Community 0 - "Locator Generation Logic"
Cohesion: 0.36
Nodes (9): buildCSSSelector(), findUniqueParent(), generateLocators(), getAccessibleName(), getHeadingLevel(), getRole(), hasUnstableClasses(), isUnstableId() (+1 more)

### Community 1 - "Sidepanel Framework UI"
Cohesion: 0.29
Nodes (0): 

### Community 2 - "Inspection Overlay & Injection"
Cohesion: 0.47
Nodes (3): createOverlay(), injectStyles(), startInspect()

### Community 3 - "DOM Tree Navigation"
Cohesion: 0.67
Nodes (4): navigateChild(), navigateParent(), onKeyDown(), updateOverlay()

### Community 4 - "Extension Popup UI"
Cohesion: 0.67
Nodes (2): toggleInspect(), updateInspectUI()

### Community 5 - "Results Rendering Helpers"
Cohesion: 0.5
Nodes (4): esc(), hl(), renderResults(), safeRender()

### Community 6 - "Framework Translators"
Cohesion: 0.5
Nodes (4): Cypress Translator, Playwright Translator, Selenium Translator, Universal Framework Matrix

### Community 7 - "Background Messaging Relay"
Cohesion: 0.67
Nodes (0): 

### Community 8 - "Interaction Event Handling"
Cohesion: 0.67
Nodes (3): getDeepElementAt(), onClick(), onMouseOver()

### Community 9 - "Decommissioning Logic"
Cohesion: 1.0
Nodes (2): removeOverlay(), stopInspect()

### Community 10 - "Sidepanel Inspection Toggle"
Cohesion: 1.0
Nodes (2): toggleInspect(), updateInspectUI()

### Community 11 - "Clipboard Helpers"
Cohesion: 1.0
Nodes (2): copyToClipboard(), handleCopy()

### Community 12 - "Shadow DOM Engine"
Cohesion: 1.0
Nodes (2): Deep-Trace Algorithm, Shadow DOM X-Ray Engine

### Community 13 - "Lumina Cyber HUD Concept"
Cohesion: 1.0
Nodes (1): Lumina Cyber HUD

### Community 14 - "Distribution Architecture"
Cohesion: 1.0
Nodes (1): Dual-Dist Junction Architecture

### Community 15 - "State Sync Shield"
Cohesion: 1.0
Nodes (1): Navigation Shield

### Community 16 - "Selector Lab Feature"
Cohesion: 1.0
Nodes (1): Selector Lab

## Knowledge Gaps
- **9 isolated node(s):** `Lumina Cyber HUD`, `Shadow DOM X-Ray Engine`, `Deep-Trace Algorithm`, `Dual-Dist Junction Architecture`, `Navigation Shield` (+4 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Decommissioning Logic`** (2 nodes): `removeOverlay()`, `stopInspect()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Sidepanel Inspection Toggle`** (2 nodes): `toggleInspect()`, `updateInspectUI()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Clipboard Helpers`** (2 nodes): `copyToClipboard()`, `handleCopy()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Shadow DOM Engine`** (2 nodes): `Deep-Trace Algorithm`, `Shadow DOM X-Ray Engine`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Lumina Cyber HUD Concept`** (1 nodes): `Lumina Cyber HUD`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Distribution Architecture`** (1 nodes): `Dual-Dist Junction Architecture`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `State Sync Shield`** (1 nodes): `Navigation Shield`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Selector Lab Feature`** (1 nodes): `Selector Lab`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `generateLocators()` connect `Locator Generation Logic` to `Interaction Event Handling`, `Inspection Overlay & Injection`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `onClick()` connect `Interaction Event Handling` to `Locator Generation Logic`, `Decommissioning Logic`, `Inspection Overlay & Injection`?**
  _High betweenness centrality (0.001) - this node is a cross-community bridge._
- **What connects `Lumina Cyber HUD`, `Shadow DOM X-Ray Engine`, `Deep-Trace Algorithm` to the rest of the system?**
  _9 weakly-connected nodes found - possible documentation gaps or missing edges._