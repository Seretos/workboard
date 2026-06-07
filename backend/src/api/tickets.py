from fastapi import APIRouter
from lib_python_projects import load_projects

router = APIRouter()


@router.get("/tickets")
async def tickets() -> list:
    result = load_projects(config_filename="projects.yml", config_filename_alt="projects.yaml")
    return [p.model_dump(mode="json", exclude_none=True) for p in result.projects]
