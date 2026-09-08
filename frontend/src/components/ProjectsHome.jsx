import React, { useMemo, useState } from 'react';

const formatUpdated = (value) => {
  if (!value) return 'Not saved yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

function ProjectsHome({
  projects,
  loading,
  error,
  onCreate,
  onOpen,
  onArchive,
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [archivingId, setArchivingId] = useState('');

  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) => (
      `${project.name || ''} ${project.description || ''}`.toLowerCase().includes(query)
    ));
  }, [projects, search]);

  const createProject = async (event) => {
    event.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const created = await onCreate({ name: name.trim(), description: description.trim() });
      if (created !== false) {
        setName('');
        setDescription('');
      }
    } finally {
      setCreating(false);
    }
  };

  const archiveProject = async (project) => {
    if (!window.confirm(`Archive "${project.name}"? Its files will be retained in the workspace archive.`)) return;
    setArchivingId(project.id);
    try {
      await onArchive(project.id);
    } finally {
      setArchivingId('');
    }
  };

  return (
    <div className="projects-home">
      <section className="project-create-panel" aria-labelledby="new-project-heading">
        <div className="project-panel-copy">
            <span className="setup-step">1</span>
          <div>
            <h3 id="new-project-heading">New project workspace</h3>
            <p>Create an independent workbook, then draw the ROI and other polygons inside the dashboard.</p>
          </div>
        </div>
        <form className="project-create-form" onSubmit={createProject}>
          <label>
            <span>Project name</span>
            <input
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder="Upper Indus snow trend"
              required
            />
          </label>
          <label>
            <span>Description <small>optional</small></span>
            <input
              value={description}
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Question, region, or analysis goal"
            />
          </label>
          <button className="dataset-start-btn" type="submit" disabled={creating || !name.trim()}>
            {creating ? 'Creating...' : 'Create workspace'}
          </button>
        </form>
      </section>

      <section className="project-library" aria-labelledby="project-library-heading">
        <div className="project-library-heading">
          <div className="project-panel-copy">
            <span className="setup-step">2</span>
            <div>
              <h3 id="project-library-heading">Your projects</h3>
              <p>Continue from the last saved dashboard and code state.</p>
            </div>
          </div>
          <label className="project-search">
            <span className="sr-only">Search projects</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search projects"
            />
          </label>
        </div>

        {error && <div className="dataset-error">{error}</div>}
        {loading ? (
          <div className="project-empty">Loading projects…</div>
        ) : filteredProjects.length ? (
          <div className="project-grid">
            {filteredProjects.map((project) => (
              <article className="project-card" key={project.id}>
                <button className="project-card-open" type="button" onClick={() => onOpen(project.id)}>
                  <span className="project-file-mark" aria-hidden="true">HB</span>
                  <span className="project-card-copy">
                    <strong>{project.name}</strong>
                    <span>{project.description || 'Hydrological research workspace'}</span>
                    <small>Updated {formatUpdated(project.updated_at)}</small>
                  </span>
                  <span className="project-open-arrow" aria-hidden="true">-&gt;</span>
                </button>
                <div className="project-card-footer">
                  <span>{project.id}</span>
                  <button
                    type="button"
                    onClick={() => archiveProject(project)}
                    disabled={archivingId === project.id}
                  >
                    {archivingId === project.id ? 'Archiving...' : 'Archive'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="project-empty">
            <strong>{projects.length ? 'No matching projects' : 'No projects yet'}</strong>
            <span>{projects.length ? 'Try another search.' : 'Create one above; its files will remain available between sessions.'}</span>
          </div>
        )}
      </section>
    </div>
  );
}

export default ProjectsHome;
