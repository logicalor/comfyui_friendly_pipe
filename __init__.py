from .friendly_pipe_in import FriendlyPipeIn
from .friendly_pipe_out import FriendlyPipeOut
from .friendly_pipe_edit import FriendlyPipeEdit

NODE_CLASS_MAPPINGS = {
    "FriendlyPipeIn": FriendlyPipeIn,
    "FriendlyPipeOut": FriendlyPipeOut,
    "FriendlyPipeEdit": FriendlyPipeEdit,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "FriendlyPipeIn": "Friendly Pipe In",
    "FriendlyPipeOut": "Friendly Pipe Out",
    "FriendlyPipeEdit": "Friendly Pipe Edit",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
