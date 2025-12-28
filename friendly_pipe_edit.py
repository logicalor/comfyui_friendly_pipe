from .any_type import ANY_TYPE

class FriendlyPipeEdit:
    """
    A pipe editing node that adds new slots to an existing FRIENDLY_PIPE.
    Allows extending pipes with additional inputs while preserving existing data.
    Also exposes incoming pipe slots as inputs to allow updating their values.
    """
    
    MAX_SLOTS = 80
    
    @classmethod
    def INPUT_TYPES(cls):
        inputs = {
            "required": {
                "pipe": ("FRIENDLY_PIPE",),
            },
            "optional": {},
            "hidden": {
                "slot_count": ("INT", {"default": 0}),
                "slot_names": ("STRING", {"default": "{}"}),
                "incoming_slot_count": ("INT", {"default": 0}),
            }
        }
        
        # Define slots for exposed incoming slots (incoming_slot_1, incoming_slot_2, etc.)
        # These are managed dynamically by the frontend based on incoming pipe
        for i in range(1, cls.MAX_SLOTS + 1):
            inputs["optional"][f"incoming_slot_{i}"] = (ANY_TYPE, {"forceInput": True})
        
        # Define additional slots as optional with ANY_TYPE
        for i in range(1, cls.MAX_SLOTS + 1):
            inputs["optional"][f"slot_{i}"] = (ANY_TYPE, {"forceInput": True})
        
        return inputs

    RETURN_TYPES = ("FRIENDLY_PIPE",)
    RETURN_NAMES = ("pipe",)
    FUNCTION = "execute"
    CATEGORY = "utils/pipe"
    
    def execute(self, pipe, slot_count=0, slot_names="{}", incoming_slot_count=0, **kwargs):
        import json
        
        # Debug: print what we received
        print(f"[FriendlyPipeEdit] execute called")
        print(f"[FriendlyPipeEdit] slot_count={slot_count}, incoming_slot_count={incoming_slot_count}")
        print(f"[FriendlyPipeEdit] kwargs keys: {list(kwargs.keys())}")
        print(f"[FriendlyPipeEdit] kwargs: {kwargs}")
        
        # Parse slot names from JSON string
        try:
            names_dict = json.loads(slot_names)
        except:
            names_dict = {}
        
        # Start with the incoming pipe data
        incoming_slots = pipe.get("slots", {})
        incoming_names = pipe.get("names", {})
        
        # Calculate actual incoming slot count from the data (more reliable than slot_count field)
        actual_incoming_count = 0
        for key in incoming_slots.keys():
            int_key = int(key) if isinstance(key, str) else key
            actual_incoming_count = max(actual_incoming_count, int_key)
        
        # Also consider the pipe's reported slot_count (for empty slots)
        actual_incoming_count = max(actual_incoming_count, pipe.get("slot_count", 0))
        
        # Use the frontend-provided incoming_slot_count if it's larger
        actual_incoming_count = max(actual_incoming_count, incoming_slot_count)
        
        # Create new pipe data combining incoming + new slots
        pipe_data = {
            "slots": {},
            "names": {},
        }
        
        # Copy incoming slots with integer keys (normalize from string if needed)
        for key, value in incoming_slots.items():
            int_key = int(key) if isinstance(key, str) else key
            pipe_data["slots"][int_key] = value
        
        # Copy incoming names with integer keys (normalize from string if needed)  
        for key, value in incoming_names.items():
            int_key = int(key) if isinstance(key, str) else key
            pipe_data["names"][int_key] = value
        
        # Override incoming slots if exposed inputs are connected
        for i in range(1, actual_incoming_count + 1):
            incoming_key = f"incoming_slot_{i}"
            print(f"[FriendlyPipeEdit] Checking {incoming_key}: present={incoming_key in kwargs}, value={kwargs.get(incoming_key, 'NOT_PRESENT')}")
            if incoming_key in kwargs and kwargs[incoming_key] is not None:
                pipe_data["slots"][i] = kwargs[incoming_key]
                print(f"[FriendlyPipeEdit] Overriding slot {i} with {kwargs[incoming_key]}")
        
        # Find the highest slot we're adding
        max_new_slot = 0
        
        # Add new slots with offset indices
        for i in range(1, slot_count + 1):
            slot_key = f"slot_{i}"
            new_index = actual_incoming_count + i
            
            if slot_key in kwargs and kwargs[slot_key] is not None:
                pipe_data["slots"][new_index] = kwargs[slot_key]
                max_new_slot = max(max_new_slot, i)
            
            # Add names with offset
            if i in names_dict:
                pipe_data["names"][new_index] = names_dict[i]
            elif str(i) in names_dict:
                pipe_data["names"][new_index] = names_dict[str(i)]
        
        # Calculate final slot count
        pipe_data["slot_count"] = actual_incoming_count + max(slot_count, max_new_slot)
        
        print(f"[FriendlyPipeEdit] Final pipe_data: {pipe_data}")
        
        return (pipe_data,)
