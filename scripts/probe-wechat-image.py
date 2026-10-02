"""Inspect only a specified whitelisted conversation's latest incoming image."""
import importlib.util
import json
import pathlib
import sys
spec = importlib.util.spec_from_file_location('reader_image_probe', pathlib.Path(__file__).with_name('reader-api.py'))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
reader = api.Reader()
target = sys.argv[1]
talkers = [talker for talker in reader.selected_talkers() if api.conversation_id(talker, reader.names) == target and reader.image_talker_allowed(talker)]
if len(talkers) != 1:
    raise RuntimeError('IMAGE_CONVERSATION_MAPPING_AMBIGUOUS')
talker = talkers[0]
messages = reader.messages(talker, limit=100)
image = next((row for row in messages if row.get('localType') in (3, 47) and not row.get('isSend')), None)
if not image:
    raise RuntimeError('NO_INCOMING_IMAGE_IN_SELECTED_CONVERSATION')
payload = api.push_payload(talker, image, reader.names, reader.own_wxid)
image_id = reader.register_image(talker, payload)
result = reader.resolve_image(image_id)
verification = {'imageId': image_id, 'conversationKey': result['conversationKey'], 'localId': image['localId'],
    'createTime': image['createTime'], 'mime': result['mime'], 'width': result['width'], 'height': result['height'], 'bytes': result['bytes']}
(reader.root / 'state' / 'image-probe.json').write_text(json.dumps(verification), encoding='utf-8')
print(json.dumps({key: value for key, value in verification.items() if key != 'conversationKey'}))
