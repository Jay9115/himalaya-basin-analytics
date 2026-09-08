from pathlib import Path

import pytest

from project_workspace.repository import InvalidProjectError, MAX_WORKSPACE_BYTES, ProjectRepository


def test_project_round_trip_keeps_state_and_code_separate(tmp_path: Path):
    repository = ProjectRepository(tmp_path)
    created = repository.create_project(
        "Upper Indus study",
        "Snow trend workspace",
        {"dashboard": {"datasetId": "era5", "currentDate": "2014-01-01"}},
        "print('snow')\n",
    )

    project_id = created["project"]["id"]
    project_dir = tmp_path / "projects" / project_id
    assert (project_dir / "project.json").exists()
    assert (project_dir / "workspace.json").exists()
    assert (project_dir / "code.py").read_text(encoding="utf-8") == "print('snow')\n"
    assert created["workspace"]["dashboard"]["datasetId"] == "era5"

    saved = repository.save_project(
        project_id,
        {"dashboard": {"datasetId": "chirps"}},
        "print('rain')\n",
    )
    assert saved["workspace"]["dashboard"]["datasetId"] == "chirps"
    assert saved["code"] == "print('rain')\n"
    assert repository.list_projects()[0]["id"] == project_id


def test_project_archive_is_recoverable(tmp_path: Path):
    repository = ProjectRepository(tmp_path)
    created = repository.create_project("Archive me")
    project_id = created["project"]["id"]

    repository.archive_project(project_id)

    assert repository.list_projects() == []
    assert list((tmp_path / "archive").glob(f"{project_id}-*"))


def test_workspace_size_is_bounded(tmp_path: Path):
    repository = ProjectRepository(tmp_path)
    with pytest.raises(InvalidProjectError, match="too large"):
        repository.create_project("Oversized", workspace={"value": "x" * MAX_WORKSPACE_BYTES})


def test_project_save_snapshots_operation_exports(tmp_path: Path):
    job_export_dir = tmp_path / "custom_operations" / "jobs" / "job-1" / "exports"
    job_export_dir.mkdir(parents=True)
    (job_export_dir / "daily_mean.csv").write_text("date,value\n2014-01-01,2\n", encoding="utf-8")

    repository = ProjectRepository(tmp_path)
    created = repository.create_project("Exports")
    project_id = created["project"]["id"]

    saved = repository.save_project(
        project_id,
        {
            "tools": {
                "code": {
                    "workspaceVersion": 2,
                    "files": [
                        {
                            "id": "main",
                            "name": "analysis.py",
                            "content": "print('x')\n",
                            "result": {
                                "ok": True,
                                "outputs": [
                                    {
                                        "type": "export_file",
                                        "filename": "daily_mean.csv",
                                        "download_url": "/operations/jobs/job-1/exports/daily_mean.csv",
                                    }
                                ],
                            },
                        }
                    ],
                }
            }
        },
        "print('x')\n",
    )

    output = saved["workspace"]["tools"]["code"]["files"][0]["result"]["outputs"][0]
    assert output["download_url"].startswith(f"/projects/{project_id}/exports/")
    export_name = output["download_url"].rsplit("/", 1)[-1]
    assert repository.get_export_path(project_id, export_name).read_text(encoding="utf-8").startswith("date,value")
