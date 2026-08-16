from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.omr import OmrDraftResult, _measure_layouts, _regions_from_layouts

from .conftest import auth


class FakeOmrProcessor:
    def process(self, source: Path, output_dir: Path) -> OmrDraftResult:
        del output_dir
        assert source.read_bytes().startswith(b"%PDF")
        return OmrDraftResult(
            regions=[
                {
                    "page": 1,
                    "measureNumber": 1,
                    "rect": {"x": 0.05, "y": 0.1, "w": 0.4, "h": 0.12},
                },
                {
                    "page": 1,
                    "measureNumber": 2,
                    "rect": {"x": 0.46, "y": 0.1, "w": 0.49, "h": 0.12},
                },
            ],
            warnings=["best effort"],
        )


def _upload_pdf(client: TestClient, ensemble: dict[str, Any]) -> dict[str, Any]:
    headers = auth(ensemble["leader"]["accessToken"])
    repertoire_id = ensemble["repertoire"]["id"]
    payload = b"%PDF-1.7\nomr"
    target = client.post(
        f"/api/repertoire/{repertoire_id}/scores/presign",
        headers=headers,
        json={
            "filename": "omr.pdf",
            "contentType": "application/pdf",
            "sizeBytes": len(payload),
            "kind": "full",
            "instrument": "",
        },
    ).json()
    assert client.put(target["uploadUrl"], content=payload, headers=target["headers"]).status_code == 204
    completed = client.post(
        f"/api/scores/{target['scoreId']}/complete",
        headers=headers,
        json={"sizeBytes": len(payload)},
    )
    assert completed.status_code == 200, completed.text
    return completed.json()


def _wait_for_job(client: TestClient, job_id: str, token: str) -> dict[str, Any]:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        response = client.get(f"/api/omr-drafts/{job_id}", headers=auth(token))
        assert response.status_code == 200, response.text
        job = response.json()
        if job["status"] in {"succeeded", "failed"}:
            return job
        time.sleep(0.01)
    raise AssertionError("OMR job did not finish")


def test_omr_job_is_persistent_permission_checked_and_revision_guarded(
    client: TestClient, ensemble: dict[str, Any]
) -> None:
    score = _upload_pdf(client, ensemble)
    leader_token = ensemble["leader"]["accessToken"]
    member_token = ensemble["member"]["accessToken"]
    client.app.state.omr_drafts.processor = FakeOmrProcessor()

    denied = client.post(
        f"/api/scores/{score['id']}/omr-drafts",
        headers=auth(member_token),
        json={"expectedMeasureMapRevision": 0},
    )
    assert denied.status_code == 403

    created = client.post(
        f"/api/scores/{score['id']}/omr-drafts",
        headers=auth(leader_token),
        json={"expectedMeasureMapRevision": 0},
    )
    assert created.status_code == 202, created.text
    finished = _wait_for_job(client, created.json()["id"], member_token)
    assert finished["status"] == "succeeded"
    assert finished["expectedMeasureMapRevision"] == 0
    assert [region["measureNumber"] for region in finished["regions"]] == [1, 2]
    assert finished["warnings"] == ["best effort"]

    saved = client.put(
        f"/api/scores/{score['id']}/measure-map",
        headers=auth(leader_token),
        json={
            "expectedRevision": finished["expectedMeasureMapRevision"],
            "measureNumberOffset": 0,
            "regions": finished["regions"],
        },
    )
    assert saved.status_code == 200, saved.text
    stale = client.post(
        f"/api/scores/{score['id']}/omr-drafts",
        headers=auth(leader_token),
        json={"expectedMeasureMapRevision": 0},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["actualRevision"] == 1


def test_musicxml_system_breaks_become_normalized_page_regions() -> None:
    layouts = _measure_layouts(
        b"""<?xml version='1.0'?>
        <score-partwise>
          <part id='P1'>
            <measure number='1'/>
            <measure number='2'/>
            <measure number='3'><print new-system='yes'/></measure>
            <measure number='4'><print new-page='yes'/></measure>
          </part>
        </score-partwise>"""
    )
    assert layouts == [(1, 0), (1, 0), (1, 1), (2, 0)]
    regions = _regions_from_layouts(layouts)
    assert [region["page"] for region in regions] == [1, 1, 1, 2]
    assert [region["measureNumber"] for region in regions] == [1, 2, 3, 4]
    for region in regions:
        rect = region["rect"]
        assert isinstance(rect, dict)
        assert 0 <= float(rect["x"]) < 1
        assert 0 <= float(rect["y"]) < 1
        assert float(rect["x"]) + float(rect["w"]) <= 1
        assert float(rect["y"]) + float(rect["h"]) <= 1
