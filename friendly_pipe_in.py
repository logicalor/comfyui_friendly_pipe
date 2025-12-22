class FriendlyPipeIn:
    """
    A pipe input node that bundles up to 80 arbitrary inputs into a single pipe output.
    Slots can be dynamically added or removed via the UI.
    Each slot can be named, and names are passed through the pipe.
    """
    
    MAX_SLOTS = 80
    
    @classmethod
    def INPUT_TYPES(cls):
        inputs = {
            "required": {},
            "optional": {},
            "hidden": {
                "slot_count": ("INT", {"default": 1}),
                "slot_names": ("STRING", {"default": "{}"}),
            }
        }
        
        # Define all possible slots as optional with wildcard type
        for i in range(1, cls.MAX_SLOTS + 1):
            inputs["optional"][f"slot_{i}"] = ("*", {"forceInput": True})
        
        return inputs

    RETURN_TYPES = ("FRIENDLY_PIPE",)
    RETURN_NAMES = ("pipe",)
    FUNCTION = "execute"
    CATEGORY = "utils/pipe"
    
    def execute(self, slot_count=1, slot_names="{}", **kwargs):
        import json
        
        # Parse slot names from JSON string
        try:
            names_dict = json.loads(slot_names)
        except:
            names_dict = {}
        
        # Collect all connected slot values into a dictionary
        pipe_data = {
            "slot_count": slot_count,
            "slots": {},
            "names": names_dict
        }
        
        for i in range(1, self.MAX_SLOTS + 1):
            slot_key = f"slot_{i}"
            if slot_key in kwargs and kwargs[slot_key] is not None:
                pipe_data["slots"][i] = kwargs[slot_key]
        
        return (pipe_data,)
