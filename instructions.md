# Azure DevOps Plugin

The Azure DevOps plugin owns every interaction with dev.azure.com in DevOps Pilot: work item tracking, sprints and iterations, velocity, teams, area paths, burndown, and AB# auto-linking.

## Phase 2/3 extraction state

During extraction the handlers still live in `dashboard/server.js`. The manifest uses absolute route paths under `/api/workitems/*`, `/api/iterations`, etc. Phase 3b moves the implementations into this plugin's `routes.js` and flips the manifest paths to relative.

## Routes described by the manifest

| Surface              | Current path                              | Purpose                                 |
|----------------------|-------------------------------------------|-----------------------------------------|
| List work items      | `GET /api/workitems`                      | Backlog / My Items / Iteration views    |
| Create work item     | `POST /api/workitems/create`              | Gated                                   |
| Get work item        | `GET /api/workitems/:id`                  | Detail view                             |
| Change state         | `PATCH /api/workitems/:id/state`          | Gated                                   |
| Comment              | `POST /api/workitems/:id/comments`        | Gated                                   |
| Iterations           | `GET /api/iterations`                     | Iteration selector                      |
| Teams                | `GET /api/teams`                          | Teams sidebar                           |
| Team members         | `GET /api/team-members`                   | Team capacity UI                        |
| Areas                | `GET /api/areas`                          | Area path picker                        |
| Velocity             | `GET /api/velocity`                       | Velocity widget                         |
| Burndown             | `GET /api/burndown`                       | Burndown chart                          |
| Start working        | `POST /api/start-working`                 | Moves item to Active, creates branch    |

## Contributions

- `workItemProvider` exposes the full work-item surface so the future provider-agnostic Backlog tab renders ADO via the same interface Jira/Wrike plugins will implement.
- `centerTabs` contributes the Backlog and Work Item tabs.
- `rightTabs` contributes Teams and Activity sidebars.
- `leftQuickActions` contributes "New Item", "My Items", "Refresh".
- `aiActions` contributes the "Standup Summary", "Iteration Status", and "Retrospective" quick AI actions.
- `commitLinkers` registers the `AB#<id>` auto-link resolver.
- `settingsHtml` will host the ADO org URL, PAT, default team, and default area path fields in Phase 3b.

## Configuration

Reads `ADO_Organization`, `ADO_Project`, `ADO_PAT`, `DefaultTeam`, `DefaultArea` from the global app config. When the config pane moves into this plugin it will continue to write to the same keys.

## AB# auto-link

The `commitLinkers` pattern `AB#(\d+)` maps to `{adoOrgUrl}/_workitems/edit/{1}`. The token `{adoOrgUrl}` is resolved by the shell using the current ADO org URL from config; plugins do not embed org URLs.
