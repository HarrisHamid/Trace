from fastapi import APIRouter, FastAPI

from fixpkg import api

api_router = APIRouter()
api_router.include_router(router=api.router, prefix="/v1")  # keyword form


def create_app():
    application = FastAPI()  # app built inside a factory
    application.include_router(api_router, prefix="/api")
    return application


class Worker:
    def __init__(self, handler):
        self.handler = handler

    def go(self):
        return self.handler()  # callable stored on an attribute -> uncertain (line 20)


class Child(Worker):
    pass
