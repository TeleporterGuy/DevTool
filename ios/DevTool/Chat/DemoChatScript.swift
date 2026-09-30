#if DEBUG
import DevToolKit
import Foundation

/// Scripted chat actions for screenshots and live runs without UI automation
/// (`-demoToolDetail`, `-demoChatScript`; see `LaunchOptions`).
@MainActor
enum DemoChatScript {
    static func run(model: ChatModel, openDetail: (ChatItem) -> Void) async {
        let options = LaunchOptions.current
        guard options.demoToolDetail != nil || options.demoChatScript else { return }
        while model.state == nil || model.showingCache {
            guard (try? await Task.sleep(for: .milliseconds(100))) != nil else { return }
        }
        if let itemId = options.demoToolDetail {
            guard (try? await Task.sleep(for: .milliseconds(700))) != nil else { return }
            if let item = model.view?.items.first(where: { $0.id == itemId }) { openDetail(item) }
        }
        guard options.demoChatScript else { return }
        guard (try? await Task.sleep(for: .seconds(1.5))) != nil else { return }
        _ = await model.send(options.demoMessage ?? "Hello from the phone")

        let delay = Duration.seconds(options.demoAnswerDelay ?? 6)
        var answered: Set<String> = []
        let deadline = ContinuousClock.now + .seconds(240)
        while ContinuousClock.now < deadline {
            guard (try? await Task.sleep(for: .milliseconds(250))) != nil else { return }
            guard let prompt = model.view?.prompts.first, !answered.contains(prompt.id) else { continue }
            guard (try? await Task.sleep(for: delay)) != nil else { return }
            answered.insert(prompt.id)
            switch prompt.content {
            case .permission:
                await model.answer(prompt, .allow(always: false))
            case .question(let questions):
                await model.answer(prompt, .answers(questions.map { question in
                    let labels = question.options.map(\.label)
                    let chosen = question.multiSelect ? Array(labels.prefix(2)) : Array(labels.prefix(1))
                    return (question: question.question, answer: ChatAnswer.joined(chosen))
                }))
            case .plan:
                await model.answer(prompt, .approvePlan)
                return
            case .unknown:
                return
            }
        }
    }
}
#endif
