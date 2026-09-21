'use strict';

(function () {
  const TIMELINE_LIMIT = 512;
  const STALE_MS = 5000;
  const renderSignatures = new WeakMap();
  const ID_FIELDS = ['run_id', 'phase_id', 'role', 'review_iteration', 'attempt_id'];
  const list = (value) => Array.isArray(value) ? value : [];
  const label = (value) => value == null ? 'Unknown' : String(value).replaceAll('_', ' ');
  const identityKey = (attempt) => JSON.stringify(ID_FIELDS.map((key) => attempt[key]));
  const attempts = (snapshot) => list(snapshot?.phases).flatMap((phase) =>
    list(phase.roles).flatMap((role) => [role.current_attempt, ...list(role.historical_attempts)].filter(Boolean)));

  function createModel() {
    return {
      authenticated: false, connection: 'loading', error: null, selectedRun: null,
      serviceId: null, snapshot: null, controllerService: null, observation: null,
      timeline: [], deliveredCursor: null, deliveredSequence: 0, timelineClipped: false, history: null, resetCount: 0,
      selectedAttempt: null, artifact: null,
    };
  }

  function applySnapshot(model, envelope) {
    const next = envelope.snapshot;
    if (!next || next.schema_version !== 1 || !['ready', 'legacy', 'no_run'].includes(next.status)) {
      throw new Error('Unsupported dashboard snapshot.');
    }
    const previous = model.snapshot;
    if (previous?.run_id === next.run_id && previous.revision > next.revision) return false;
    if (previous?.run_id !== next.run_id) {
      model.timeline = [];
      model.deliveredCursor = null;
      model.deliveredSequence = 0;
      model.timelineClipped = false;
      model.resetCount = 0;
      model.selectedAttempt = null;
      model.artifact = null;
    }
    model.snapshot = next;
    model.serviceId = envelope.service_id;
    model.controllerService = envelope.controller_service;
    model.observation = null;
    model.history = next.history;
    const available = attempts(next);
    const selected = available.find((attempt) => identityKey(attempt) === model.selectedAttempt);
    if (!selected) {
      model.selectedAttempt = available.length ? identityKey(available[0]) : null;
      model.artifact = null;
    } else if (model.artifact?.acceptedSignature !== JSON.stringify(selected.artifacts)) {
      model.artifact = null;
    }
    return true;
  }

  function applyEvents(model, page) {
    if (page.run_id !== model.snapshot?.run_id) return;
    const events = list(page.events).filter((event) => event.run_id === page.run_id &&
      typeof event.event_id === 'string' && Number.isSafeInteger(event.sequence));
    const merged = new Map(model.timeline.map((event) => [`${event.run_id}:${event.event_id}`, event]));
    for (const event of events) merged.set(`${event.run_id}:${event.event_id}`, event);
    const sorted = [...merged.values()].sort((a, b) => a.sequence - b.sequence);
    model.timelineClipped ||= sorted.length > TIMELINE_LIMIT;
    model.timeline = sorted.slice(-TIMELINE_LIMIT);
    // Only a received event can advance this cursor; committed cursors may lead projection.
    for (const event of events) {
      if (event.sequence > model.deliveredSequence) {
        model.deliveredCursor = event.event_id;
        model.deliveredSequence = event.sequence;
      }
    }
    model.history = page.history;
  }

  function resetTimeline(model) {
    model.deliveredCursor = null;
    model.deliveredSequence = 0;
    model.resetCount++;
  }

  function applyObservation(model, observation) {
    if (observation.run_id !== model.snapshot?.run_id) return false;
    if (model.observation && Date.parse(observation.reader_observed_at) < Date.parse(model.observation.reader_observed_at)) return false;
    model.observation = observation;
    model.controllerService = observation.controller_service;
    model.history = observation.history;
    return observation.revision !== model.snapshot.revision ||
      (model.selectedRun === null && observation.current_run_id !== model.snapshot.run_id);
  }

  function displayState(model, now = Date.now()) {
    const snapshot = model.snapshot;
    const readerAt = model.observation?.reader_observed_at || snapshot?.reader_observed_at;
    const age = readerAt ? now - Date.parse(readerAt) : Infinity;
    const stale = !Number.isFinite(age) || age > STALE_MS || age < -STALE_MS;
    const result = { stale, readerAt, message: '', tone: 'neutral' };
    if (model.connection === 'access') result.message = 'Local access required.';
    else if (model.connection === 'loading') result.message = 'Loading dashboard snapshot...';
    else if (model.connection === 'disconnected') {
      result.message = 'Disconnected from live updates. Showing the last available snapshot; retrying automatically.';
      result.tone = 'warning';
    } else if (model.error) {
      result.message = model.error;
      result.tone = 'warning';
    } else if (stale) {
      result.message = 'Stale reader observation. Current controller and worker health are not established.';
      result.tone = 'warning';
    } else if (snapshot?.status === 'no_run') result.message = 'No run recorded. Waiting for a canonical run; this page cannot start one.';
    else if (snapshot?.status === 'legacy') result.message = 'Legacy history: uncorrelated, read-only records. Completion is not independently verified.';
    else if (list(snapshot?.phases).some((phase) => phase.status === 'needs_operator' || list(phase.blockers).length)) {
      result.message = 'Intervention required. Inspect the phase blockers and use the operator terminal.';
      result.tone = 'warning';
    } else if (snapshot?.phases.length && snapshot.phases.every((phase) => ['completed', 'failed', 'cancelled'].includes(phase.status))) {
      result.message = 'Terminal run state recorded. Reported completion and QA evidence do not establish independently verified success.';
    } else result.message = 'Observing committed progress. This dashboard is read-only.';
    return result;
  }

  function createClient({ model, fetch, EventSource, onChange }) {
    let source = null;
    let sourceRun = null;
    let generation = 0;
    let pending = null;
    let refreshAgain = false;
    let lastRefresh = 0;
    let artifactRequest = 0;
    let stopped = false;

    function closeStream() {
      source?.close();
      source = null;
      sourceRun = null;
    }

    function expire(message = 'Dashboard access expired. Request a new code in your local terminal.') {
      generation++;
      artifactRequest++;
      closeStream();
      pending = null;
      Object.assign(model, createModel(), { connection: 'access', error: message });
      onChange();
    }

    async function request(url, options = {}) {
      const response = await fetch(url, {
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000), ...options,
      });
      if (response.status === 204) return null;
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data?.error?.message || 'Dashboard request failed.');
        error.status = response.status;
        error.code = data?.error?.code;
        throw error;
      }
      return data;
    }

    function failed(error) {
      if (error.status === 401) expire();
      else {
        model.error = error.status ? error.message : 'Dashboard is unavailable. Retrying without changing run state.';
        model.connection = 'disconnected';
        onChange();
      }
    }

    function openStream() {
      const runId = model.snapshot?.run_id;
      if (!runId || (source && sourceRun === runId)) return;
      closeStream();
      const query = new URLSearchParams({ run_id: runId });
      if (model.deliveredCursor) query.set('after', model.deliveredCursor);
      const stream = new EventSource(`/api/stream?${query}`);
      source = stream;
      sourceRun = runId;
      const listen = (name, handler) => stream.addEventListener(name, (event) => {
        if (source !== stream) return;
        if (name === 'error' && !event.data) {
          if (stream.readyState === 2) closeStream();
          model.connection = 'disconnected';
          onChange();
          void refresh();
          return;
        }
        let data;
        try { data = JSON.parse(event.data); } catch (_) {
          model.error = 'Invalid live update. Refreshing canonical state.';
          closeStream();
          onChange();
          void refresh();
          return;
        }
        if (data.service_id && data.service_id !== model.serviceId) {
          expire('Dashboard service changed. Request a new local access code.');
          return;
        }
        handler(data);
      });
      listen('observation', (data) => {
        model.connection = 'connected';
        model.error = null;
        const changed = applyObservation(model, data);
        onChange();
        if (changed) void refresh();
      });
      listen('events', (data) => {
        applyEvents(model, data);
        onChange();
        if (data.revision > model.snapshot.revision) void refresh();
      });
      listen('reset', (data) => {
        if (data.run_id !== model.snapshot?.run_id) return;
        resetTimeline(model);
        model.history = data.history || model.history;
        closeStream();
        onChange();
        void refresh();
      });
      listen('error', (data) => {
        if (['AUTH_EXPIRED', 'AUTH_REQUIRED'].includes(data.error?.code)) expire();
        else {
          model.error = data.error?.message || 'Live observations are unavailable.';
          model.connection = 'disconnected';
          onChange();
          if (data.error?.code === 'RUN_NOT_FOUND') closeStream();
          void refresh();
        }
      });
    }

    function refresh() {
      if (!model.authenticated || stopped) return Promise.resolve();
      if (pending) { refreshAgain = true; return pending; }
      const epoch = generation;
      const operation = (async () => {
        do {
          refreshAgain = false;
          try {
            const query = model.selectedRun === null ? '' : `?${new URLSearchParams({ run_id: model.selectedRun })}`;
            const envelope = await request(`/api/snapshot${query}`);
            if (epoch !== generation || stopped) return;
            if (model.serviceId && model.serviceId !== envelope.service_id) {
              expire('Dashboard service changed. Request a new local access code.');
              return;
            }
            applySnapshot(model, envelope);
            model.error = null;
            if (!source || !model.snapshot.run_id) model.connection = 'connected';
            openStream();
            lastRefresh = Date.now();
            onChange();
          } catch (error) {
            if (epoch === generation && !stopped) failed(error);
            return;
          }
        } while (refreshAgain && epoch === generation);
      })();
      pending = operation;
      void operation.finally(() => { if (pending === operation) pending = null; });
      return operation;
    }

    async function start() {
      stopped = false;
      model.connection = 'loading';
      onChange();
      const epoch = generation;
      try {
        const session = await request('/api/session');
        if (epoch !== generation || stopped) return;
        model.authenticated = true;
        model.serviceId = session.service_id;
        await refresh();
      } catch (error) { if (epoch === generation && !stopped) failed(error); }
    }

    async function login(code) {
      const epoch = generation;
      model.error = null;
      onChange();
      try {
        await request('/api/bootstrap', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
        });
        if (epoch === generation && !stopped) await start();
      } catch (error) {
        if (epoch !== generation || stopped) return;
        model.connection = 'access';
        model.error = error.status ? error.message : 'Local dashboard access is unavailable. Try again.';
        onChange();
      }
    }

    function selectRun(runId) {
      generation++;
      artifactRequest++;
      closeStream();
      pending = null;
      model.selectedRun = runId || null;
      model.snapshot = null;
      model.observation = null;
      model.artifact = null;
      model.connection = 'loading';
      onChange();
      return refresh();
    }

    function selectAttempt(key) {
      if (!attempts(model.snapshot).some((attempt) => identityKey(attempt) === key)) return;
      artifactRequest++;
      model.selectedAttempt = key;
      model.artifact = null;
      onChange();
    }

    async function loadArtifact(kind) {
      const attempt = attempts(model.snapshot).find((item) => identityKey(item) === model.selectedAttempt);
      if (!attempt || !attempt.artifacts.some((artifact) => artifact.kind === kind && artifact.path)) return;
      const sequence = ++artifactRequest;
      const epoch = generation;
      const key = model.selectedAttempt;
      const acceptedSignature = JSON.stringify(attempt.artifacts);
      model.artifact = { kind, status: 'loading', acceptedSignature };
      onChange();
      try {
        const query = new URLSearchParams({ ...Object.fromEntries(ID_FIELDS.map((field) => [field, attempt[field]])), kind });
        const data = await request(`/api/artifact?${query}`);
        if (epoch !== generation || sequence !== artifactRequest || key !== model.selectedAttempt || stopped) return;
        const selected = attempts(model.snapshot).find((item) => identityKey(item) === key);
        if (JSON.stringify(selected?.artifacts) !== acceptedSignature) return;
        model.artifact = { kind, status: 'ready', data, acceptedSignature };
        onChange();
      } catch (error) {
        if (epoch !== generation || sequence !== artifactRequest || stopped) return;
        if (error.status === 401) expire();
        else {
          model.artifact = { kind, status: 'error', message: error.status ? error.message : 'Artifact request failed. Try again.', acceptedSignature };
          onChange();
        }
      }
    }

    return {
      start, login, refresh, selectRun, selectAttempt, loadArtifact,
      idle: async () => { while (pending) await pending; },
      tick() {
        onChange();
        if (model.authenticated && Date.now() - lastRefresh >= STALE_MS) void refresh();
      },
      stop() { stopped = true; generation++; artifactRequest++; closeStream(); },
    };
  }

  function renderDashboard(document, model, now = Date.now()) {
    const node = (tag, text, attrs = {}) => {
      const element = document.createElement(tag);
      if (text != null) element.textContent = String(text);
      for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
      return element;
    };
    const paragraph = (text, className = '') => node('p', text, { class: className });
    const definition = (entries) => {
      const dl = node('dl', null, { class: 'facts' });
      for (const [term, value] of entries) dl.append(node('dt', term), node('dd', value ?? 'Unknown'));
      return dl;
    };
    const update = (id, signature, build) => {
      const target = document.getElementById(id);
      const serialized = JSON.stringify(signature);
      if (renderSignatures.get(target) === serialized) return;
      const focus = document.activeElement?.getAttribute('data-focus');
      target.replaceChildren(...build());
      renderSignatures.set(target, serialized);
      if (focus) {
        const replacement = [...target.querySelectorAll('[data-focus]')].find((element) => element.getAttribute('data-focus') === focus);
        replacement?.focus({ preventScroll: true });
      }
    };
    const state = displayState(model, now);
    const snapshot = model.snapshot;
    document.getElementById('access').hidden = model.connection !== 'access';
    document.getElementById('dashboard').hidden = !model.authenticated;
    document.getElementById('access-error').textContent = model.error || '';
    update('notice', [state.message, state.tone], () => [paragraph(state.message, `notice ${state.tone}`)]);
    if (!model.authenticated) return;
    const observation = model.observation || snapshot;
    const ageText = (time) => {
      if (!time) return 'Unknown';
      const age = Math.floor((now - Date.parse(time)) / 1000);
      return `${time} (${age < 0 ? 'clock ahead' : `${age}s ago`})`;
    };
    const observedStatus = (record) => {
      const age = now - Date.parse(record?.observed_at);
      const stale = Number.isFinite(age) && (age > STALE_MS || age < -STALE_MS);
      return `${label(record?.status)}${stale ? ' (stale observation)' : ''}; observed ${ageText(record?.observed_at)}`;
    };
    update('freshness', [observation, model.controllerService, state.stale, Math.floor(now / 1000)], () => [
      definition([
        ['Reader freshness', `${state.stale ? 'Stale' : 'Fresh'}: ${ageText(observation?.reader_observed_at)}`],
        ['Canonical state updated', snapshot?.updated_at],
        ['Run-correlated controller', observedStatus(observation?.controller)],
        ['Workspace controller service', observedStatus(model.controllerService)],
      ]),
      paragraph('Reader freshness and workspace service readiness do not prove that a worker is live.', 'muted'),
    ]);
    update('identity', [snapshot?.run_id, snapshot?.current_run_id, snapshot?.revision, snapshot?.accepted_revision,
      snapshot?.status, snapshot?.paused, snapshot?.prior_runs, model.selectedRun, snapshot?.limits], () => {
      const select = node('select', null, { id: 'run-select', 'data-focus': 'run-select' });
      select.append(node('option', 'Follow current run', { value: '' }));
      const ids = new Set([snapshot?.current_run_id, ...list(snapshot?.prior_runs).map((run) => run.run_id), snapshot?.run_id].filter(Boolean));
      for (const id of ids) select.append(node('option', `${id}${id === snapshot?.current_run_id ? ' (current, pinned)' : ' (history)'}`, { value: id }));
      select.value = model.selectedRun || '';
      return [
        node('label', 'Run selection', { for: 'run-select' }), select,
        definition([
          ['Selected run', snapshot?.run_id || (snapshot?.status === 'legacy' ? 'Legacy / uncorrelated' : 'No run')],
          ['View', model.selectedRun ? 'Pinned run (does not follow reruns)' : 'Following current run'],
          ['Canonical revision / accepted revision', `${snapshot?.revision ?? 'Unknown'} / ${snapshot?.accepted_revision ?? 'Unknown'}`],
          ['Scheduling', snapshot?.paused === true ? 'Paused by operator' : snapshot?.paused === false ? 'Not paused' : 'Unknown'],
        ]),
        paragraph('Production dispatch is disabled. Historical inspection is not live engine acceptance.', 'muted'),
        ...Object.entries(snapshot?.limits || {}).filter(([, limit]) => limit.truncated)
          .map(([name, limit]) => paragraph(`Partial ${label(name)}: showing ${limit.shown} of ${limit.total}.`, 'warning')),
      ];
    });
    update('phases', [snapshot?.phases, snapshot?.legacy_history, model.selectedAttempt], () => {
      if (!snapshot?.phases.length) return [paragraph(snapshot ? 'No phases available.' : 'Loading phases...')];
      const table = node('table');
      table.append(node('caption', 'Phase dependencies, roles and review progress'));
      const head = node('thead');
      const header = node('tr');
      for (const title of ['Phase / dependencies', 'Recorded status / blockers', 'Roles / attempts']) header.append(node('th', title, { scope: 'col' }));
      head.append(header);
      const body = node('tbody');
      for (const phase of snapshot.phases) {
        const row = node('tr');
        const name = node('th', null, { scope: 'row', 'data-label': 'Phase / dependencies' });
        name.append(node('strong', phase.phase_id), paragraph(phase.dependencies_known === false
          ? 'Dependencies unknown' : `Depends on: ${phase.depends_on.join(', ') || 'None'}`));
        const status = node('td', null, { 'data-label': 'Status / blockers' });
        status.append(node('span', label(phase.recorded_status || phase.status), { class: 'badge' }));
        if (phase.review) status.append(paragraph(`Review iteration ${phase.review.iteration}; stage ${label(phase.review.stage)}`));
        for (const blocker of list(phase.blockers)) status.append(paragraph(`${label(blocker.category)}: ${blocker.message}`, 'warning'));
        if (phase.review?.history.length) status.append(paragraph(`QA review history: ${phase.review.history.map((review) =>
          `iteration ${review.review_iteration}: ${label(review.verdict)} (worker evidence)`).join('; ')}`));
        for (const [name, limit] of Object.entries({ ...phase.limits, review_history: phase.review?.history_limits })) {
          if (limit?.truncated) status.append(paragraph(`Partial ${label(name)}: ${limit.shown} of ${limit.total}.`, 'warning'));
        }
        const roles = node('td', null, { 'data-label': 'Roles / attempts' });
        if (!phase.roles.length) roles.append(paragraph('Uncorrelated legacy record.'));
        for (const role of phase.roles) {
          roles.append(paragraph(`${role.role}: ${role.current_attempt ? label(role.current_attempt.status) : 'No current attempt'}`));
          for (const attempt of [role.current_attempt, ...role.historical_attempts].filter(Boolean)) {
            const key = identityKey(attempt);
            roles.append(node('button', `${role.role} / iteration ${attempt.review_iteration} / ${attempt.attempt_id}${attempt.eligible_for_current_progress ? ' (current)' : ' (historical)'}`, {
              type: 'button', 'data-attempt': key, 'data-focus': key, 'aria-pressed': model.selectedAttempt === key,
            }));
          }
        }
        row.append(name, status, roles);
        body.append(row);
      }
      table.append(head, body);
      const legacy = list(snapshot.legacy_history).flatMap((record, index) => [
        node('h3', `Imported legacy record ${index + 1}`),
        paragraph('Uncorrelated history; not current completion or independent verification.', 'muted'),
        ...list(record.phases).map((phase) => paragraph(`${phase.phase_id}: ${label(phase.recorded_status)}`)),
        ...(record.limits?.phases?.truncated ? [paragraph('Legacy phase history is truncated.', 'warning')] : []),
      ]);
      return [table, ...legacy];
    });
    const selected = attempts(snapshot).find((attempt) => identityKey(attempt) === model.selectedAttempt);
    update('attempt', [selected, model.artifact], () => {
      if (!selected) return [paragraph('Select an attempt to inspect its evidence. No current attempt is selected.')];
      const content = [
        definition(ID_FIELDS.map((key) => [label(key), selected[key]])),
        paragraph(selected.eligible_for_current_progress ? 'Current attempt for this review iteration.' : 'Historical attempt. Its evidence does not complete the current attempt.', 'muted'),
        definition([
          ['Recorded attempt status', label(selected.status)],
          ['Completion', label(selected.completion.status)],
          ['QA evidence', selected.qa_verdict.provenance ? `${label(selected.qa_verdict.status)} (worker report)` : 'Unknown / no accepted QA verdict'],
          ['Independent verification', 'Unknown / no independent verification evidence'],
          ['Engine / access', `${label(selected.engine)} / ${label(selected.access)}`],
          ['Session / submission', `${label(selected.session.status)} / ${label(selected.submission.status)}`],
          ['Engine observation', `${label(selected.engine_observation.status)}; observed ${selected.engine_observation.observed_at || 'Unknown'}`],
          ['Checkout reservation', label(selected.reservation.state)],
        ]),
      ];
      if (selected.completion.status === 'unknown' || !selected.qa_verdict.provenance || selected.diagnostics.length) {
        content.push(paragraph('Partial evidence. Missing or rejected reports remain unknown; artifact existence is not accepted completion.', 'warning'));
      }
      for (const diagnostic of selected.diagnostics) content.push(paragraph(`${diagnostic.kind}: ${label(diagnostic.code)}`, 'warning'));
      for (const artifact of selected.artifacts) {
        const section = node('div', null, { class: 'artifact-entry' });
        section.append(node('button', `Read ${artifact.kind}`, {
          type: 'button', 'data-artifact': artifact.kind, 'data-focus': `artifact-${artifact.kind}`,
          ...(artifact.path ? {} : { disabled: '' }),
        }), paragraph(artifact.provenance
          ? `Accepted worker report at ${artifact.provenance.observed_at}; SHA-256 ${artifact.provenance.sha256}`
          : 'No accepted provenance. File may be absent.', 'muted'));
        content.push(section);
      }
      const history = selected.evidence_history_limits;
      content.push(paragraph(`Accepted evidence history: ${history.shown} of ${history.total}; rejected ${history.rejected}.${history.truncated ? ' History is truncated.' : ''}`));
      const artifact = model.artifact;
      if (artifact) {
        content.push(node('h3', `${label(artifact.kind)} artifact`));
        if (artifact.status === 'loading') content.push(paragraph('Loading artifact...'));
        else if (artifact.status === 'error') content.push(paragraph(artifact.message, 'warning'));
        else {
          content.push(paragraph(artifact.data.matches_accepted === true
            ? 'Bytes match the accepted worker report. This is not independent verification.'
            : 'These bytes do not match accepted evidence, or no accepted hash is available.', 'warning'));
          content.push(definition([['Read SHA-256', artifact.data.sha256], ['Accepted SHA-256', artifact.data.accepted_sha256]]));
          content.push(node('pre', artifact.data.content, { tabindex: '0', 'aria-label': 'Untrusted artifact text' }));
        }
      }
      return content;
    });
    update('timeline', [model.timeline, model.history, model.resetCount, model.timelineClipped, observation?.projection], () => {
      const history = model.history;
      const content = [paragraph(`History: ${label(history?.status)}. Projection: ${label(observation?.projection?.status)}.`)];
      if (history?.status !== 'complete') content.push(paragraph('History gap or unavailable history. Canonical progress remains authoritative.', 'warning'));
      for (const gap of list(history?.gaps)) content.push(paragraph(`Events ${gap.from}-${gap.to}: ${label(gap.reason)}`, 'warning'));
      if (history?.diagnostic) content.push(paragraph(`${history.diagnostic.code}: ${history.diagnostic.message}`, 'warning'));
      if (observation?.projection?.diagnostic) content.push(paragraph(observation.projection.diagnostic.message, 'warning'));
      if (model.resetCount) content.push(paragraph(`History reset ${model.resetCount} time(s). Replayed events are deduplicated; progress was not rolled back.`));
      if (model.timelineClipped) content.push(paragraph(`Partial timeline: only the latest ${TIMELINE_LIMIT} received events are retained in this page.`, 'warning'));
      if (!model.timeline.length) content.push(paragraph('No projected events received.'));
      const ol = node('ol', null, { class: 'events' });
      for (const event of model.timeline) {
        const li = node('li');
        li.append(paragraph(`${label(event.type)} / revision ${event.revision} / ${event.event_id}`),
          node('pre', JSON.stringify(event.payload, null, 2)));
        ol.append(li);
      }
      content.push(ol);
      return content;
    });
  }

  function mount(document, window) {
    const model = createModel();
    let wasAccess = false;
    const client = createClient({
      model, fetch: window.fetch.bind(window), EventSource: window.EventSource,
      onChange() {
        renderDashboard(document, model);
        const access = model.connection === 'access';
        if (access && !wasAccess) document.getElementById('access-code').focus();
        wasAccess = access;
      },
    });
    document.getElementById('access-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = document.getElementById('access-code');
      const button = document.getElementById('access-submit');
      const code = input.value.trim();
      input.value = '';
      button.disabled = true;
      await client.login(code);
      button.disabled = false;
      if (model.authenticated) document.getElementById('run-select')?.focus();
    });
    document.getElementById('identity').addEventListener('change', (event) => {
      if (event.target.id === 'run-select') void client.selectRun(event.target.value);
    });
    document.getElementById('phases').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-attempt]');
      if (button) client.selectAttempt(button.dataset.attempt);
    });
    document.getElementById('attempt').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-artifact]');
      if (button) void client.loadArtifact(button.dataset.artifact);
    });
    document.getElementById('refresh').addEventListener('click', () => {
      if (model.authenticated) void client.refresh();
      else void client.start();
    });
    const timer = window.setInterval(() => client.tick(), 1000);
    window.addEventListener('pagehide', () => { window.clearInterval(timer); client.stop(); });
    window.addEventListener('pageshow', (event) => { if (event.persisted) window.location.reload(); });
    void client.start();
    return client;
  }

  const api = { TIMELINE_LIMIT, STALE_MS, createModel, applySnapshot, applyEvents, resetTimeline,
    applyObservation, displayState, createClient, renderDashboard, identityKey, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else mount(document, window);
})();
