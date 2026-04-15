# Azure DevOps Plugin for DevOps Pilot

Integrates Azure DevOps into DevOps Pilot: work items, iterations, teams, velocity, burndown, and `AB#` commit auto-linking.

## Installation

1. Clone into your DevOps Pilot plugins folder:
   ```
   git clone https://github.com/M8N-MatanDessaur/devops-pilot-plugin-azure-devops.git dashboard/plugins/azure-devops
   ```
2. Restart DevOps Pilot.
3. Open **Settings -> Plugins -> Azure DevOps** and fill in your org, project, PAT, and default team.

## What it contributes

- `workItemProvider` -- powers the Backlog center tab and work-item detail view.
- `centerTabs: Backlog, Work Item` and `rightTabs: Teams, Activity`.
- `leftQuickActions: New Item, My Items, Refresh`.
- `aiActions: Standup Summary, Iteration Status, Retrospective`.
- `commitLinkers` -- auto-links `AB#<id>` in commit messages and branch names.
- `configKeys` / `sensitiveKeys` -- keep Azure DevOps config in this plugin's `config.json` and scrub PATs from exports.

## Routes

The HTTP handlers live in this plugin's `routes.js`. Legacy `/api/workitems/*`, `/api/iterations`, `/api/teams`, and related paths are still registered so older UI code and scripts keep working.

## Uninstall

Delete the `dashboard/plugins/azure-devops/` folder and restart. Your work items stay in Azure DevOps untouched.
