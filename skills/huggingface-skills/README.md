# Hugging Face Skills

Hugging Face 官方：在 Hub 上找模型和数据集，训练、评测、发布模型。

这是一组技能（共 25 个），装上后 agent 在需要时按技能说明去做。

## 包含的技能

- **hf-cli**：Hugging Face Hub CLI (`hf`) for downloading, uploading, and managing models, datasets, spaces, buckets, repos, papers, jobs, and more on the Hugging Face Hub.
- **hf-cloud-aws-context-discovery**：Discover the user's local AWS context (active profile, region, account ID, caller identity) at the start of any AWS task.
- **hf-cloud-python-env-setup**：Set up an isolated Python environment for SageMaker / AWS work, with the right Python version and current boto3.
- **hf-cloud-sagemaker-deployment-planner**：Plan and coordinate the deployment of a model to Amazon SageMaker AI.
- **hf-cloud-sagemaker-iam-preflight**：Ensure a usable SageMaker execution role exists before deploying or training.
- **hf-cloud-sagemaker-production-defaults**：Create a SageMaker endpoint (real-time, real-time scale-to-zero, or async) with autoscaling, CloudWatch alarms, and tagging enabled by default.
- **hf-cloud-serving-image-selection**：Pick the right serving container for a SageMaker model deployment and find its current image URI.
- **hf-mem**：Hugging Face CLI to estimate the required memory to load Safetensors or GGUF model weights for inference from the Hugging Face Hub
- **huggingface-best**：Use when the user asks about finding the best, top, or recommended model for a task, wants to know what AI model to use, or wants to compare models by benchmark scores.
- **huggingface-community-evals**：Run evaluations for Hugging Face Hub models using inspect-ai and lighteval on local hardware.
- **huggingface-datasets**：Use this skill for Hugging Face Dataset Viewer API workflows that fetch subset/split metadata, paginate rows, search text, apply filters, download parquet URLs, and read size or statistics.
- **huggingface-gradio**：Build Gradio web UIs and demos in Python. Use when creating or editing Gradio apps, components, event listeners, layouts, or chatbots.
- **huggingface-llm-trainer**：Train or fine-tune language and vision models using TRL (Transformer Reinforcement Learning) or Unsloth with Hugging Face Jobs infrastructure.
- **huggingface-local-models**：Use to select models to run locally with llama.cpp and GGUF on CPU, Mac Metal, CUDA, or ROCm.
- **huggingface-lora-space-builder**：Build and publish a Gradio demo on Hugging Face Spaces for a user-provided LoRA.
- **huggingface-paper-publisher**：Publish and manage research papers on Hugging Face Hub.
- **huggingface-papers**：Look up and read Hugging Face paper pages in markdown, and use the papers API for structured metadata such as authors, linked models/datasets/spaces, Github repo and project page.
- **huggingface-spaces**：Build, deploy, and maintain applications on Hugging Face Spaces — Gradio / Docker / Static SDKs, ZeroGPU and dedicated hardware, model loading, debugging, buckets, inference providers, community grants.
- **huggingface-tool-builder**：Use this skill when the user wants to build tool/scripts or achieve a task where using data from the Hugging Face API would help.
- **huggingface-trackio**：Track and visualize ML training experiments with Trackio.
- **huggingface-vision-trainer**：Trains and fine-tunes vision models for object detection (D-FINE, RT-DETR v2, DETR, YOLOS), image classification (timm models — MobileNetV3, MobileViT, ResNet, ViT/DINOv3 — plus any Transformers classifier), and SAM/SAM2 segmentation using Hugging Face Transformers on Hugging Face Jobs cloud GPUs.
- **huggingface-zerogpu**：AI demos and GPU compute with Gradio Spaces and Hugging Face Spaces ZeroGPU.
- **train-sentence-transformers**：Train or fine-tune sentence-transformers models across `SentenceTransformer` (bi-encoder, dense or static embedding model for retrieval, similarity, clustering,…
- **transformers-js**：Use Transformers.js to run state-of-the-art machine learning models directly in JavaScript/TypeScript.
- **trl-training**：Post-train LLMs with TRL (Transformers Reinforcement Learning) — SFT, DPO, GRPO, KTO, and reward-model training.

## 来源

- 上游仓库：<https://github.com/huggingface/skills>
- commit：[`25910b3d0ba31a2ba102f901cdc9e008c278a69c`](https://github.com/huggingface/skills/tree/25910b3d0ba31a2ba102f901cdc9e008c278a69c/skills)，目录 `skills`
- 许可证：Apache-2.0
