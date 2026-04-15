// Azure DevOps plugin -- owns every /api/workitems/*, /api/iterations,
// /api/teams, /api/areas, /api/velocity, /api/burndown, /api/team-members,
// /api/start-working route.
//
// Registers at absolute paths via the new ctx.addAbsoluteRoute SDK so the
// URL contracts the core frontend and AI already use keep working after
// extraction. When the plugin is uninstalled / unconfigured the routes
// 404 naturally (no handler registered).

module.exports = function register(ctx) {
  const { shell } = ctx;
  const {
    https, fs,
    gitExec, sanitizeText, permGate, incognitoGuard,
    getRepoPath, spawnSync, SWRCache, broadcast,
  } = shell;

  const json = (res, data, status) => {
    res.writeHead(status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // --- ADO HTTP helpers ----------------------------------------------------

  function adoRequest(method, apiPath, body, contentType, _skipTeam) {
    return new Promise((resolve, reject) => {
      const cfg = ctx.getConfig();
      const org = cfg.AzureDevOpsOrg;
      const project = cfg.AzureDevOpsProject;
      const pat = cfg.AzureDevOpsPAT;
      const team = cfg.DefaultTeam;
      if (!org || !project || !pat) {
        return reject(new Error('Azure DevOps not configured. Set Org, Project, and PAT in Settings > Plugins > Azure DevOps.'));
      }
      const useTeam = !_skipTeam && team && apiPath.startsWith('/work/');
      const teamSegment = useTeam ? `/${encodeURIComponent(team)}` : '';
      const url = new URL(`https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}${teamSegment}/_apis${apiPath}`);
      const payload = body ? JSON.stringify(body) : null;
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          'Authorization': 'Basic ' + Buffer.from(':' + pat).toString('base64'),
          'Content-Type': contentType || 'application/json',
          'Accept': 'application/json',
        },
      };
      if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
      const req = https.request(options, (resp) => {
        let data = '';
        resp.on('data', c => { data += c; });
        resp.on('end', () => {
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (_) { resolve(data); }
          } else if (resp.statusCode === 404 && useTeam && !_skipTeam) {
            adoRequest(method, apiPath, body, contentType, true).then(resolve, reject);
          } else {
            const msg = resp.statusCode === 401
              ? 'Authentication failed -- PAT may be expired or invalid'
              : `Azure DevOps API error (${resp.statusCode}): ${data.slice(0, 200)}`;
            reject(new Error(msg));
          }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  function adoOrgRequest(method, apiPath) {
    return new Promise((resolve, reject) => {
      const cfg = ctx.getConfig();
      const org = cfg.AzureDevOpsOrg;
      const pat = cfg.AzureDevOpsPAT;
      if (!org || !pat) return reject(new Error('Azure DevOps not configured.'));
      const url = new URL(`https://dev.azure.com/${encodeURIComponent(org)}/_apis${apiPath}`);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          'Authorization': 'Basic ' + Buffer.from(':' + pat).toString('base64'),
          'Accept': 'application/json',
        },
      };
      const req = https.request(options, (resp) => {
        let data = '';
        resp.on('data', c => { data += c; });
        resp.on('end', () => {
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (_) { resolve(data); }
          } else {
            reject(new Error(`ADO org API error (${resp.statusCode})`));
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  function proxyHtmlImages(html) {
    if (!html) return html;
    return html.replace(/<img([^>]+)src=["']([^"']+)["']/gi, (match, before, url) => {
      if (url.includes('dev.azure.com') || url.includes('visualstudio.com')) {
        return `<img${before}src="/api/image-proxy?url=${encodeURIComponent(url)}"`;
      }
      return match;
    });
  }

  // --- SWR caches ----------------------------------------------------------

  const swrIterations = SWRCache ? new SWRCache({ staleTTL: 60000, maxAge: 300000, onRevalidate: (key, data) => broadcast && broadcast({ type: 'cache-updated', cache: 'iterations', data }) }) : null;
  const swrWorkItems  = SWRCache ? new SWRCache({ staleTTL: 15000, maxAge: 60000,  onRevalidate: (key, data) => broadcast && broadcast({ type: 'cache-updated', cache: 'workitems', key, data }) }) : null;
  const swrTeamAreas  = SWRCache ? new SWRCache({ staleTTL: 300000, maxAge: 600000 }) : null;
  const swrAreas      = SWRCache ? new SWRCache({ staleTTL: 300000, maxAge: 600000 }) : null;

  async function getTeamAreaPaths() {
    const cfg = ctx.getConfig();
    const team = cfg.DefaultTeam;
    if (!team) return null;
    try {
      const fetcher = async () => {
        const data = await adoRequest('GET', `/work/teamsettings/teamfieldvalues?api-version=7.1`);
        return (data.values || []).map(v => v.value).filter(Boolean);
      };
      return swrTeamAreas ? await swrTeamAreas.get('teamAreas:' + team, fetcher) : await fetcher();
    } catch (_) { return null; }
  }

  // --- Handlers ------------------------------------------------------------

  async function fetchIterations() {
    const data = await adoRequest('GET', '/work/teamsettings/iterations?api-version=7.1');
    const now = new Date();
    const iterations = (data.value || []).map(it => {
      const startDate = it.attributes && it.attributes.startDate ? new Date(it.attributes.startDate) : null;
      const finishDate = it.attributes && it.attributes.finishDate ? new Date(it.attributes.finishDate) : null;
      const isCurrent = startDate && finishDate && now >= startDate && now <= finishDate;
      return {
        id: it.id, name: it.name, path: it.path,
        startDate: (it.attributes && it.attributes.startDate) || null,
        finishDate: (it.attributes && it.attributes.finishDate) || null,
        timeFrame: (it.attributes && it.attributes.timeFrame) || null,
        isCurrent,
      };
    });
    iterations.sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1;
      if (!a.isCurrent && b.isCurrent) return 1;
      const da = a.startDate ? new Date(a.startDate) : new Date(0);
      const db = b.startDate ? new Date(b.startDate) : new Date(0);
      return db - da;
    });
    return iterations;
  }

  async function handleIterations(req, res, url) {
    try {
      if (incognitoGuard && incognitoGuard(res, 'read iterations')) return;
      const forceRefresh = url && url.searchParams.get('refresh') === '1';
      const iterations = swrIterations
        ? await swrIterations.get('iterations', fetchIterations, { forceRefresh })
        : await fetchIterations();
      json(res, iterations);
    } catch (e) {
      json(res, { error: e.message }, e.message.includes('not configured') ? 400 : 502);
    }
  }

  async function fetchWorkItemsData(iterationPath, state, type, assignedTo, areaPath, closedTop, fetchClosedSeparately, noClosedFilter) {
    let areaClause = '';
    if (areaPath) {
      areaClause = ` AND [System.AreaPath] UNDER '${areaPath}'`;
    } else {
      const teamAreas = await getTeamAreaPaths();
      if (teamAreas && teamAreas.length > 0) {
        const areaConditions = teamAreas.map(a => `[System.AreaPath] UNDER '${a}'`).join(' OR ');
        areaClause = ` AND (${areaConditions})`;
      }
    }
    let wiqlQuery = `SELECT [System.Id] FROM WorkItems WHERE [System.State] NOT IN ('Removed')`;
    if (noClosedFilter) wiqlQuery += ` AND [System.State] NOT IN ('Closed', 'Done')`;
    wiqlQuery += areaClause;
    if (iterationPath) wiqlQuery += ` AND [System.IterationPath] = '${iterationPath}'`;
    if (state)         wiqlQuery += ` AND [System.State] = '${state}'`;
    if (type)          wiqlQuery += ` AND [System.WorkItemType] = '${type}'`;
    if (assignedTo)    wiqlQuery += ` AND [System.AssignedTo] = '${assignedTo}'`;
    wiqlQuery += ` ORDER BY [System.ChangedDate] DESC`;

    const mainPromise = adoRequest('POST', '/wit/wiql?$top=200&api-version=7.1', { query: wiqlQuery });
    let closedPromise = null;
    if (fetchClosedSeparately) {
      let closedQuery = `SELECT [System.Id] FROM WorkItems WHERE [System.State] IN ('Closed', 'Done') AND [System.State] NOT IN ('Removed')`;
      closedQuery += areaClause;
      if (type)       closedQuery += ` AND [System.WorkItemType] = '${type}'`;
      if (assignedTo) closedQuery += ` AND [System.AssignedTo] = '${assignedTo}'`;
      closedQuery += ` ORDER BY [System.ChangedDate] DESC`;
      const closedCap = Math.max(closedTop, 200) + 1;
      closedPromise = adoRequest('POST', `/wit/wiql?$top=${closedCap}&api-version=7.1`, { query: closedQuery });
    }
    const [wiql, closedWiql] = await Promise.all([mainPromise, closedPromise]);
    const mainIds = (wiql.workItems || []).map(w => w.id).slice(0, 200);
    let closedIds = [];
    let hasMoreClosed = false;
    let totalClosed = 0;
    let totalClosedCapped = false;
    if (closedWiql) {
      const returnedClosedIds = (closedWiql.workItems || []).map(w => w.id);
      const closedCap = Math.max(closedTop, 200);
      totalClosedCapped = returnedClosedIds.length > closedCap;
      hasMoreClosed = returnedClosedIds.length > closedTop;
      closedIds = returnedClosedIds.slice(0, closedTop);
      totalClosed = totalClosedCapped ? closedCap : returnedClosedIds.length;
    }
    const allIds = [...new Set([...mainIds, ...closedIds])];
    if (allIds.length === 0) {
      return fetchClosedSeparately ? { items: [], hasMoreClosed: false, totalClosed: 0, totalClosedCapped: false } : [];
    }
    const batches = [];
    for (let i = 0; i < allIds.length; i += 200) batches.push(allIds.slice(i, i + 200));
    const detailResults = await Promise.all(batches.map(batch =>
      adoRequest('GET',
        `/wit/workitems?ids=${batch.join(',')}&fields=System.Id,System.Title,System.State,System.WorkItemType,System.AssignedTo,System.Tags,System.CreatedDate,System.ChangedDate,Microsoft.VSTS.Common.Priority,System.IterationPath,Microsoft.VSTS.Scheduling.StoryPoints,Microsoft.VSTS.Scheduling.Effort,System.Parent&api-version=7.1`
      )
    ));
    const items = detailResults.flatMap(d => (d.value || []).map(wi => {
      const f = wi.fields;
      return {
        id: wi.id,
        title: f['System.Title'],
        state: f['System.State'],
        type: f['System.WorkItemType'],
        assignedTo: f['System.AssignedTo'] ? f['System.AssignedTo'].displayName : '',
        tags: f['System.Tags'] || '',
        changedDate: f['System.ChangedDate'],
        priority: f['Microsoft.VSTS.Common.Priority'] || 0,
        iterationPath: f['System.IterationPath'] || '',
        storyPoints: f['Microsoft.VSTS.Scheduling.StoryPoints'] || f['Microsoft.VSTS.Scheduling.Effort'] || '',
        createdDate: f['System.CreatedDate'] || '',
        parentId: f['System.Parent'] || null,
      };
    }));
    return fetchClosedSeparately ? { items, hasMoreClosed, totalClosed, totalClosedCapped } : items;
  }

  async function handleWorkItems(req, res, url) {
    try {
      if (incognitoGuard && incognitoGuard(res, 'read work items')) return;
      const refresh = url.searchParams.get('refresh') === '1';
      const iterationPath = url.searchParams.get('iteration') || '';
      const state = url.searchParams.get('state') || '';
      const type = url.searchParams.get('type') || '';
      const assignedTo = url.searchParams.get('assignedTo') || '';
      const areaPath = url.searchParams.get('area') || '';
      const closedTopParam = url.searchParams.get('closedTop');
      const closedTop = Math.min(parseInt(closedTopParam || '10', 10) || 10, 200);
      const noClosedFilter = !iterationPath && !state;
      const fetchClosedSeparately = noClosedFilter && closedTopParam !== null;
      const cacheKey = `${iterationPath}|${state}|${type}|${assignedTo}|${areaPath}|ct${closedTopParam !== null ? closedTop : '-'}`;
      const fetcher = () => fetchWorkItemsData(iterationPath, state, type, assignedTo, areaPath, closedTop, fetchClosedSeparately, noClosedFilter);
      const result = swrWorkItems
        ? await swrWorkItems.get('wi:' + cacheKey, fetcher, { forceRefresh: refresh })
        : await fetcher();
      json(res, result);
    } catch (e) {
      json(res, { error: e.message }, e.message.includes('not configured') ? 400 : 502);
    }
  }

  async function handleWorkItemDetail(req, res, id) {
    try {
      if (incognitoGuard && incognitoGuard(res, 'read work item')) return;
      const cfg = ctx.getConfig();
      const org = cfg.AzureDevOpsOrg;
      const project = cfg.AzureDevOpsProject;
      const [wi, commentsData] = await Promise.all([
        adoRequest('GET', `/wit/workitems/${id}?$expand=all&api-version=7.1`),
        adoRequest('GET', `/wit/workitems/${id}/comments?api-version=7.1-preview.4`).catch(() => ({ comments: [] })),
      ]);
      const f = wi.fields;
      const attachments = [];
      const linkedItems = [];
      (wi.relations || []).forEach(rel => {
        if (rel.rel === 'AttachedFile') {
          attachments.push({ name: (rel.attributes && rel.attributes.name) || 'attachment', url: rel.url, comment: (rel.attributes && rel.attributes.comment) || '' });
        } else {
          const idMatch = rel.url && rel.url.match(/workItems\/(\d+)/i);
          linkedItems.push({ rel: rel.rel, title: (rel.attributes && rel.attributes.name) || '', comment: (rel.attributes && rel.attributes.comment) || '', id: idMatch ? parseInt(idMatch[1]) : null, url: rel.url });
        }
      });
      const comments = (commentsData.comments || []).map(c => ({
        id: c.id, text: proxyHtmlImages(c.text || ''),
        author: c.createdBy ? c.createdBy.displayName : '',
        date: c.createdDate || '',
      }));
      json(res, {
        id: wi.id, title: f['System.Title'], state: f['System.State'],
        type: f['System.WorkItemType'],
        assignedTo: f['System.AssignedTo'] ? f['System.AssignedTo'].displayName : '',
        createdBy: f['System.CreatedBy'] ? f['System.CreatedBy'].displayName : '',
        tags: f['System.Tags'] || '',
        createdDate: f['System.CreatedDate'] || '',
        changedDate: f['System.ChangedDate'],
        priority: f['Microsoft.VSTS.Common.Priority'] || 0,
        severity: f['Microsoft.VSTS.Common.Severity'] || '',
        storyPoints: f['Microsoft.VSTS.Scheduling.StoryPoints'] || '',
        effort: f['Microsoft.VSTS.Scheduling.Effort'] || '',
        reason: f['System.Reason'] || '',
        description: proxyHtmlImages(f['System.Description'] || ''),
        acceptanceCriteria: proxyHtmlImages(f['Microsoft.VSTS.Common.AcceptanceCriteria'] || ''),
        reproSteps: proxyHtmlImages(f['Microsoft.VSTS.TCM.ReproSteps'] || ''),
        areaPath: f['System.AreaPath'] || '',
        iterationPath: f['System.IterationPath'] || '',
        attachments, linkedItems, comments,
        webUrl: org && project ? `https://dev.azure.com/${org}/${project}/_workitems/edit/${wi.id}` : '',
      });
    } catch (e) {
      json(res, { error: e.message }, e.message.includes('not configured') ? 400 : 502);
    }
  }

  async function handleUpdateWorkItem(req, res, id) {
    try {
      if (incognitoGuard && incognitoGuard(res, 'update work item')) return;
      if (permGate && !(await permGate(res, 'api', `PATCH /api/workitems/${id}`, `Update work item #${id}`))) return;
      const body = await ctx.readBody(req);
      const patchDoc = [];
      const fieldMap = {
        title: '/fields/System.Title',
        description: '/fields/System.Description',
        state: '/fields/System.State',
        assignedTo: '/fields/System.AssignedTo',
        priority: '/fields/Microsoft.VSTS.Common.Priority',
        tags: '/fields/System.Tags',
        iterationPath: '/fields/System.IterationPath',
        areaPath: '/fields/System.AreaPath',
        storyPoints: '/fields/Microsoft.VSTS.Scheduling.StoryPoints',
        acceptanceCriteria: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria',
      };
      const textFields = ['title', 'description', 'tags', 'acceptanceCriteria'];
      for (const [key, path] of Object.entries(fieldMap)) {
        if (body[key] !== undefined) {
          const val = textFields.includes(key) ? sanitizeText(body[key]) : body[key];
          patchDoc.push({ op: 'replace', path, value: val });
        }
      }
      if (patchDoc.length === 0) return json(res, { error: 'No fields to update' }, 400);
      const result = await adoRequest('PATCH', `/wit/workitems/${id}?api-version=7.1`, patchDoc, 'application/json-patch+json');
      if (swrWorkItems) swrWorkItems.invalidate('wi:');
      if (broadcast) broadcast({ type: 'ui-action', action: 'refresh-workitems' });
      json(res, { ok: true, id: result.id });
    } catch (e) { json(res, { error: e.message }, 502); }
  }

  async function handleWorkItemState(req, res, id) {
    try {
      if (incognitoGuard && incognitoGuard(res, 'change work item state')) return;
      if (permGate && !(await permGate(res, 'api', `PATCH /api/workitems/${id}/state`, `Change state of work item #${id}`))) return;
      const { state } = await ctx.readBody(req);
      if (!state) return json(res, { error: 'state is required' }, 400);
      const result = await adoRequest('PATCH', `/wit/workitems/${id}?api-version=7.1`,
        [{ op: 'replace', path: '/fields/System.State', value: state }],
        'application/json-patch+json');
      if (swrWorkItems) swrWorkItems.invalidate('wi:');
      if (broadcast) broadcast({ type: 'ui-action', action: 'refresh-workitems' });
      json(res, { ok: true, id: result.id, state: result.fields['System.State'] });
    } catch (e) { json(res, { error: e.message }, 502); }
  }

  async function handleAddWorkItemComment(req, res, id) {
    try {
      if (incognitoGuard && incognitoGuard(res, 'add work item comment')) return;
      if (permGate && !(await permGate(res, 'api', `POST /api/workitems/${id}/comments`, `Comment on work item #${id}`))) return;
      const { text } = await ctx.readBody(req);
      if (!text) return json(res, { error: 'text is required' }, 400);
      const result = await adoRequest('POST',
        `/wit/workitems/${id}/comments?api-version=7.1-preview.4`,
        { text: sanitizeText(text) });
      json(res, { ok: true, id: result.id, text: result.text, author: (result.createdBy && result.createdBy.displayName) || '', date: result.createdDate || '' });
    } catch (e) { json(res, { error: e.message }, 502); }
  }

  async function handleCreateWorkItem(req, res) {
    try {
      if (incognitoGuard && incognitoGuard(res, 'create work item')) return;
      if (permGate && !(await permGate(res, 'api', 'POST /api/workitems/create', 'Create work item'))) return;
      const { type, title, description, priority, tags, assignedTo, iterationPath, storyPoints, acceptanceCriteria } = await ctx.readBody(req);
      if (!type || !title) return json(res, { error: 'type and title are required' }, 400);
      const patchDoc = [{ op: 'add', path: '/fields/System.Title', value: sanitizeText(title) }];
      if (description)       patchDoc.push({ op: 'add', path: '/fields/System.Description', value: sanitizeText(description) });
      if (priority)          patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: parseInt(priority, 10) || 2 });
      if (tags)              patchDoc.push({ op: 'add', path: '/fields/System.Tags', value: sanitizeText(tags) });
      if (assignedTo)        patchDoc.push({ op: 'add', path: '/fields/System.AssignedTo', value: assignedTo });
      if (iterationPath)     patchDoc.push({ op: 'add', path: '/fields/System.IterationPath', value: iterationPath });
      if (storyPoints)       patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: parseFloat(storyPoints) });
      if (acceptanceCriteria) patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: sanitizeText(acceptanceCriteria) });
      const wiType = encodeURIComponent(type);
      const result = await adoRequest('POST', `/wit/workitems/$${wiType}?api-version=7.1`, patchDoc, 'application/json-patch+json');
      if (broadcast) broadcast({ type: 'ui-action', action: 'refresh-workitems' });
      const cfg = ctx.getConfig();
      json(res, {
        ok: true, id: result.id, title: result.fields['System.Title'],
        url: cfg.AzureDevOpsOrg && cfg.AzureDevOpsProject
          ? `https://dev.azure.com/${cfg.AzureDevOpsOrg}/${cfg.AzureDevOpsProject}/_workitems/edit/${result.id}`
          : null,
      });
    } catch (e) { json(res, { error: e.message }, 502); }
  }

  async function handleVelocity(req, res) {
    try {
      if (incognitoGuard && incognitoGuard(res, 'read velocity')) return;
      const iterData = await adoRequest('GET', '/work/teamsettings/iterations?api-version=7.1');
      const now = new Date();
      const pastIterations = (iterData.value || [])
        .filter(it => {
          const finish = it.attributes && it.attributes.finishDate ? new Date(it.attributes.finishDate) : null;
          return finish && finish < now;
        })
        .sort((a, b) => new Date(a.attributes.startDate) - new Date(b.attributes.startDate))
        .slice(-10);
      const velocity = [];
      for (const it of pastIterations) {
        const wiql = await adoRequest('POST', '/wit/wiql?$top=200&api-version=7.1', {
          query: `SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] = '${it.path}' AND [System.State] IN ('Closed', 'Resolved', 'Done') ORDER BY [System.Id]`,
        });
        const ids = (wiql.workItems || []).map(w => w.id).slice(0, 200);
        let totalPoints = 0;
        let completedCount = 0;
        if (ids.length > 0) {
          const details = await adoRequest('GET',
            `/wit/workitems?ids=${ids.join(',')}&fields=Microsoft.VSTS.Scheduling.StoryPoints,Microsoft.VSTS.Scheduling.Effort&api-version=7.1`);
          for (const wi of (details.value || [])) {
            const pts = wi.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || wi.fields['Microsoft.VSTS.Scheduling.Effort'] || 0;
            totalPoints += pts;
            completedCount++;
          }
        }
        velocity.push({
          iteration: it.name, path: it.path,
          startDate: it.attributes && it.attributes.startDate,
          finishDate: it.attributes && it.attributes.finishDate,
          completedPoints: totalPoints, completedCount,
        });
      }
      const avg = velocity.length > 0
        ? velocity.reduce((sum, v) => sum + v.completedPoints, 0) / velocity.length
        : 0;
      json(res, { velocity, averageVelocity: Math.round(avg * 10) / 10 });
    } catch (e) { json(res, { error: e.message }, 502); }
  }

  async function handleBurndown(req, res, url) {
    try {
      if (incognitoGuard && incognitoGuard(res, 'read burndown')) return;
      const iterationPath = url.searchParams.get('iteration') || '';
      if (!iterationPath) return json(res, { error: 'iteration parameter required' }, 400);
      const iterData = await adoRequest('GET', '/work/teamsettings/iterations?api-version=7.1');
      const iteration = (iterData.value || []).find(it => it.path === iterationPath);
      if (!iteration) return json(res, { error: 'Iteration not found' }, 404);
      const wiql = await adoRequest('POST', '/wit/wiql?$top=200&api-version=7.1', {
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] = '${iterationPath}' AND [System.State] NOT IN ('Removed') ORDER BY [System.Id]`,
      });
      const ids = (wiql.workItems || []).map(w => w.id).slice(0, 200);
      let totalPoints = 0, completedPoints = 0, items = [];
      if (ids.length > 0) {
        const details = await adoRequest('GET',
          `/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.State,Microsoft.VSTS.Scheduling.StoryPoints,Microsoft.VSTS.Scheduling.Effort,System.ChangedDate&api-version=7.1`);
        items = (details.value || []).map(wi => {
          const pts = wi.fields['Microsoft.VSTS.Scheduling.StoryPoints'] || wi.fields['Microsoft.VSTS.Scheduling.Effort'] || 0;
          const state = wi.fields['System.State'];
          const isDone = ['Closed', 'Resolved', 'Done'].includes(state);
          totalPoints += pts;
          if (isDone) completedPoints += pts;
          return { id: wi.id, title: wi.fields['System.Title'], state, points: pts, isDone, changedDate: wi.fields['System.ChangedDate'] };
        });
      }
      json(res, {
        iteration: iteration.name,
        startDate: iteration.attributes && iteration.attributes.startDate,
        finishDate: iteration.attributes && iteration.attributes.finishDate,
        totalPoints, completedPoints,
        remainingPoints: totalPoints - completedPoints,
        totalItems: items.length,
        completedItems: items.filter(i => i.isDone).length,
        items,
      });
    } catch (e) { json(res, { error: e.message }, 502); }
  }

  async function handleTeams(req, res) {
    try {
      if (incognitoGuard && incognitoGuard(res, 'read teams')) return;
      const cfg = ctx.getConfig();
      const project = cfg.AzureDevOpsProject;
      const data = await adoOrgRequest('GET', `/projects/${encodeURIComponent(project)}/teams?api-version=7.1`);
      const teams = (data.value || []).map(t => ({ id: t.id, name: t.name, description: t.description || '' }));
      json(res, teams);
    } catch (e) { json(res, { error: e.message }, 502); }
  }

  async function handleAreas(req, res) {
    try {
      if (incognitoGuard && incognitoGuard(res, 'read areas')) return;
      const fetcher = async () => {
        const data = await adoRequest('GET', `/wit/classificationnodes/Areas?$depth=10&api-version=7.1`, null, null, true);
        const result = [];
        (function walk(node, prefix) {
          const p = prefix ? `${prefix}\\${node.name}` : node.name;
          result.push(p);
          if (node.children) for (const child of node.children) walk(child, p);
        })(data, '');
        return result;
      };
      const areas = swrAreas ? await swrAreas.get('areas', fetcher) : await fetcher();
      json(res, areas);
    } catch (e) { json(res, { error: e.message }, 502); }
  }

  async function handleTeamMembers(req, res) {
    try {
      if (incognitoGuard && incognitoGuard(res, 'read team members')) return;
      const cfg = ctx.getConfig();
      const project = cfg.AzureDevOpsProject;
      const teamsData = await adoOrgRequest('GET', `/projects/${encodeURIComponent(project)}/teams?api-version=7.1`);
      const memberMap = new Map();
      const fetches = (teamsData.value || []).map(t =>
        adoOrgRequest('GET', `/projects/${encodeURIComponent(project)}/teams/${encodeURIComponent(t.name)}/members?api-version=7.1`).catch(() => ({ value: [] }))
      );
      const results = await Promise.all(fetches);
      for (const data of results) {
        for (const m of (data.value || [])) {
          const id = m.identity && m.identity.id;
          if (id && !memberMap.has(id)) {
            memberMap.set(id, {
              id,
              displayName: (m.identity && m.identity.displayName) || '',
              uniqueName: (m.identity && m.identity.uniqueName) || '',
              imageUrl: (m.identity && m.identity.imageUrl) || '',
            });
          }
        }
      }
      const members = [...memberMap.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
      json(res, members);
    } catch (e) { json(res, { error: e.message }, 502); }
  }

  async function handleStartWorking(req, res) {
    try {
      if (incognitoGuard && incognitoGuard(res, 'start working on work item')) return;
      const { workItemId, repoName } = await ctx.readBody(req);
      const cfg = ctx.getConfig();
      const repoPath = cfg.Repos && cfg.Repos[repoName];
      if (!repoPath) return json(res, { error: `Repo "${repoName}" not found in config` }, 400);
      if (!fs.existsSync(repoPath)) return json(res, { error: `Path does not exist: ${repoPath}` }, 400);
      const wi = await adoRequest('GET', `/wit/workitems/${workItemId}?fields=System.Title,System.WorkItemType,System.Description&api-version=7.1`);
      const title = wi.fields['System.Title'] || 'work';
      const description = (wi.fields['System.Description'] || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
      const wiType = wi.fields['System.WorkItemType'] || 'feature';
      const prefix = wiType.toLowerCase() === 'bug' ? 'bugfix' : 'feature';
      const fallbackSlug = () => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      const sanitizeSlug = (s) => String(s || '').trim().split('\n')[0].trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      const looksLikeQuestion = (s) => /\?|^(which|what|can|could|should|how|who|where|why)\b/i.test(String(s || '').trim());
      let slug;
      if (spawnSync) {
        try {
          const prompt = `Generate a short git branch slug (2 to 5 words, lowercase, hyphen-separated, no special chars) that clearly describes this work item. Reply with ONLY the slug, nothing else. Do not ask questions. Do not add quotes or commentary.\n\nTitle: ${title}\nType: ${wiType}${description ? `\nDescription: ${description}` : ''}`;
          const result = spawnSync('claude', ['--print'], { input: prompt, encoding: 'utf8', timeout: 20000, windowsHide: true, shell: true });
          const raw = (result.stdout || '').trim();
          if (result.status === 0 && raw && !looksLikeQuestion(raw)) slug = sanitizeSlug(raw);
        } catch (_) {}
      }
      if (!slug) slug = fallbackSlug();
      const branchName = `${prefix}/AB#${workItemId}-${slug}`;
      try {
        await adoRequest('PATCH', `/wit/workitems/${workItemId}?api-version=7.1`,
          [{ op: 'replace', path: '/fields/System.State', value: 'Active' }],
          'application/json-patch+json');
        if (swrWorkItems) swrWorkItems.invalidate('wi:');
      } catch (_) {}
      const gitSteps = [];
      try {
        let baseBranch = 'main';
        try { gitExec(repoPath, 'checkout main'); } catch (_) {
          baseBranch = 'master'; gitExec(repoPath, 'checkout master');
        }
        gitSteps.push(`checked out ${baseBranch}`);
        try { gitExec(repoPath, 'fetch origin'); gitSteps.push('fetched origin'); } catch (e) { gitSteps.push(`fetch failed: ${e.message}`); }
        try { gitExec(repoPath, 'pull'); gitSteps.push('pulled'); } catch (e) { gitSteps.push(`pull failed: ${e.message}`); }
        gitExec(repoPath, `checkout -b ${branchName}`);
        gitSteps.push(`created branch ${branchName}`);
      } catch (e) {
        return json(res, { error: `Git operation failed: ${e.message}`, steps: gitSteps }, 500);
      }
      json(res, { ok: true, branchName, repoPath, steps: gitSteps });
    } catch (e) { json(res, { error: e.message }, 500); }
  }

  // --- Route registration --------------------------------------------------

  // Dynamic paths: the SDK's addAbsoluteRoute takes exact URLs. For /api/workitems/<id>
  // variants we use addAbsolutePrefixRoute to match /api/workitems/* and pattern-match
  // inside the handler.
  ctx.addAbsoluteRoute('GET',  '/api/iterations',         handleIterations);
  ctx.addAbsoluteRoute('GET',  '/api/workitems',          handleWorkItems);
  ctx.addAbsoluteRoute('POST', '/api/workitems/create',   handleCreateWorkItem);
  ctx.addAbsoluteRoute('GET',  '/api/velocity',           handleVelocity);
  ctx.addAbsoluteRoute('GET',  '/api/burndown',           handleBurndown);
  ctx.addAbsoluteRoute('GET',  '/api/teams',              handleTeams);
  ctx.addAbsoluteRoute('GET',  '/api/areas',              handleAreas);
  ctx.addAbsoluteRoute('GET',  '/api/team-members',       handleTeamMembers);
  ctx.addAbsoluteRoute('POST', '/api/start-working',      handleStartWorking);

  // /api/workitems/<id> and its sub-paths require pattern matching.
  ctx.addAbsolutePrefixRoute('/api/workitems', (req, res, url, subpath) => {
    const s = subpath || '';
    const mState   = s.match(/^\/(\d+)\/state$/);
    const mComment = s.match(/^\/(\d+)\/comments$/);
    const mItem    = s.match(/^\/(\d+)$/);
    if (mState && req.method === 'PATCH') return handleWorkItemState(req, res, mState[1]);
    if (mComment && req.method === 'POST') return handleAddWorkItemComment(req, res, mComment[1]);
    if (mItem && req.method === 'GET')   return handleWorkItemDetail(req, res, mItem[1]);
    if (mItem && req.method === 'PATCH') return handleUpdateWorkItem(req, res, mItem[1]);
    return false; // not our path -- fall through
  });
};
