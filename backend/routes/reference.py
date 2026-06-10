from fastapi import APIRouter, HTTPException
from pathlib import Path

router = APIRouter()
REFERENCE_DIR = Path(__file__).parent.parent.parent / "reference"


@router.get("/reference/{module_slug}")
def get_reference(module_slug: str):
    ref_path = REFERENCE_DIR / f"{module_slug}.md"
    try:
        ref_path.resolve().relative_to(REFERENCE_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=404, detail="No reference card for this module")
    if not ref_path.exists():
        raise HTTPException(status_code=404, detail="No reference card for this module")
    return {"content": ref_path.read_text()}
