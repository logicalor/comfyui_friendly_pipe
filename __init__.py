from .friendly_pipe_in import FriendlyPipeIn
from .friendly_pipe_out import FriendlyPipeOut

NODE_CLASS_MAPPINGS = {
    "FriendlyPipeIn": FriendlyPipeIn,
    "FriendlyPipeOut": FriendlyPipeOut,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "FriendlyPipeIn": "Friendly Pipe In",
    "FriendlyPipeOut": "Friendly Pipe Out",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
