# Local speaker identification components

The optional runtime uses `sherpa-onnx-node` 1.13.8 (Apache-2.0), with its matching
native platform package. Source and notices:
https://github.com/k2-fsa/sherpa-onnx

The separately downloaded model is WeSpeaker ResNet34-LM trained on VoxCeleb,
exported as `wespeaker_en_voxceleb_resnet34_LM.onnx` by the sherpa-onnx project.
The model is not committed to this repository. Its upstream attribution and model
license follow WeSpeaker's pretrained-model documentation (VoxCeleb, CC BY 4.0):
https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md
https://mm.kaist.ac.kr/datasets/voxceleb/
https://creativecommons.org/licenses/by/4.0/

Download: https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models

Size: 26,530,550 bytes.
SHA-256: `e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012`.
The installer and helper validate this exact hash before loading the model.

The model is trained on English-language data. Performance with Dutch household
speech, noise and the user's microphone has not been established. Identification
is an experimental conversational hint, not authentication, liveness detection,
speaker separation, or a calibrated identity probability.
