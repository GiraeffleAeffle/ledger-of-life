---
status: accepted
---

# Give every feature one home area and show only references elsewhere

A feature that fits several areas (home solar, a GPU node, fictional local-company and housing units) was operated or advertised in three to five places, and four hand-kept lists disagreed about where it lived. Each feature now has one home area, where the person operates it. Every other area shows at most one line and a link. Topics (Identity & life, Home & living, Money & ownership, Energy & devices, Places & participation) organise browsing; areas are where things are operated, so a topic can be owned by an area its name does not suggest: Energy & devices is operated in Money.

The alternative was to let each area present a complete view of every topic that touches it, for example a solar card in Home, in Money and in Me. That answers "where would I look?" from every direction, but it copies controls and wording, and the copies drift. Before this decision the repository already rendered one calculator twice and used three names for the same share-backed deposit.

## Consequences

- Placement is data. The catalogue gives every capability one topic and at most one destination, and `SECTIONS` maps every jump target to its only area. Tests fail when a link names a different area than the one that renders its target, and when an adapter is operated outside the area that owns its topic.
- Money is four tabs (Holdings, Shares & loans, Local stakes, Devices & income). Home solar sits beside the validator and the local AI node; Me owns only connection settings.
- A new feature names its home before it is built. The questions to ask, in order, are in [the information architecture](../INFORMATION_ARCHITECTURE.md).
- This decides where features live, not which money a feature may touch. That stays with [ADR 0001](0001-separate-rental-security-and-personal-portfolio.md).
