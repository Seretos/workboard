from fastapi import APIRouter
from lib_python_projects import load_projects

router = APIRouter()


@router.get("/tickets")
async def tickets() -> list:
    result = load_projects()
    return [p.model_dump(mode="json", exclude_none=True) for p in result.projects]
